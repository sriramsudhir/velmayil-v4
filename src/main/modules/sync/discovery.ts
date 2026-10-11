import dgram from 'node:dgram'
import { hostname, networkInterfaces } from 'node:os'

/**
 * Finding the Admin system on the LAN without typing an address.
 *
 * The CLIENT asks (UDP broadcast on every network card), the ADMIN answers (unicast, straight back). Only the Admin has to
 * accept an inbound packet, and it already needs that firewall permission for the sync server itself; the answer to the
 * client is a reply to its own outbound packet, which Windows Firewall lets through by default.
 * The answer never contains the pairing code: discovery only says "an Admin system is at this address and port".
 */
export const DISCOVERY_PORT = 47878
const ASK = 'VELMAYIL-POS-WHO-IS-ADMIN/1'
const ANSWER = 'velmayil-pos-admin'

export interface LanAddress {
  /** Windows adapter name, e.g. "Ethernet" */
  name: string
  address: string
  netmask: string
  broadcast: string
  /** 169.254.x.x: the address Windows gives itself when two PCs are joined by a cable with no router */
  linkLocal: boolean
}

const toInt = (ip: string): number => ip.split('.').reduce((n, p) => ((n << 8) | (Number(p) & 255)) >>> 0, 0)
const toIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')

/** IPv4 addresses other computers on the LAN can use to reach this one (cabled adapters first). */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const mask = toInt(a.netmask)
      out.push({ name, address: a.address, netmask: a.netmask, broadcast: toIp((toInt(a.address) | (~mask >>> 0)) >>> 0), linkLocal: a.address.startsWith('169.254.') })
    }
  }
  // real cable first, then Wi-Fi; adapters of virtual machines / hotspots last (they are rarely the link to the other laptop)
  const rank = (a: LanAddress) =>
    /vethernet|virtual|vmware|vbox|hyper-v|bluetooth|loopback|\*/i.test(a.name) ? 3 : /ethernet|^lan|^eth/i.test(a.name) ? 0 : /wi-?fi|wlan|wireless/i.test(a.name) ? 1 : 2
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export interface AdminInfo {
  /** TCP port of the sync server */
  port: number
  name: string
  code: string
  device: string
}

export interface FoundAdmin extends AdminInfo {
  /** address the answer came from = address this computer can reach the Admin on */
  address: string
  host: string
}

/** Admin side: answers "who is admin?" questions. Failure to start is not fatal (manual address entry still works). */
export class DiscoveryResponder {
  private sock: dgram.Socket | null = null
  port: number | null = null

  start(port: number, info: () => AdminInfo | null): Promise<number | null> {
    this.stop()
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      let settled = false
      const finish = (p: number | null) => {
        if (settled) return
        settled = true
        resolve(p)
      }
      sock.on('error', () => {
        if (this.sock === sock) this.stop()
        else try { sock.close() } catch { /* ignore */ }
        finish(null)
      })
      sock.on('message', (msg, rinfo) => {
        if (msg.toString('utf8').trim() !== ASK) return
        const i = info()
        if (!i) return
        const body = Buffer.from(JSON.stringify({ app: ANSWER, v: 1, host: hostname(), ...i }))
        sock.send(body, rinfo.port, rinfo.address, () => undefined)
      })
      sock.bind(port, () => {
        this.sock = sock
        this.port = sock.address().port
        sock.unref()
        finish(this.port)
      })
    })
  }

  stop(): void {
    const s = this.sock
    this.sock = null
    this.port = null
    try {
      s?.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Client side: ask on every network card and collect the answers for `timeoutMs`. `targets` replaces the broadcast
 * addresses (tests; or asking one known address). Never throws; an empty list means "nobody answered".
 */
export function discoverAdmins(opts: { port?: number; timeoutMs?: number; targets?: string[] } = {}): Promise<FoundAdmin[]> {
  const port = opts.port ?? DISCOVERY_PORT
  const found = new Map<string, FoundAdmin>()
  const socks: dgram.Socket[] = []
  const ask = Buffer.from(ASK)
  const open = (bindAddress: string | undefined, targets: string[]) => {
    try {
      const s = dgram.createSocket({ type: 'udp4' })
      socks.push(s)
      s.on('error', () => undefined)
      s.on('message', (msg, rinfo) => {
        try {
          const j = JSON.parse(msg.toString('utf8')) as Partial<AdminInfo> & { app?: string; host?: string }
          if (j.app !== ANSWER || !Number.isInteger(j.port)) return
          found.set(`${rinfo.address}:${j.port}`, {
            address: rinfo.address, port: j.port as number, name: String(j.name ?? ''), code: String(j.code ?? ''), device: String(j.device ?? ''), host: String(j.host ?? '')
          })
        } catch {
          /* not ours */
        }
      })
      s.bind(0, bindAddress, () => {
        try {
          s.setBroadcast(true)
        } catch {
          /* ignore */
        }
        const send = () => { for (const t of targets) s.send(ask, port, t, () => undefined) }
        send()
        setTimeout(send, 300).unref?.() // UDP may drop: ask twice
      })
    } catch {
      /* this adapter cannot be used: the others still can */
    }
  }
  if (opts.targets) open(undefined, opts.targets)
  else for (const a of lanAddresses()) open(a.address, [...new Set([a.broadcast, '255.255.255.255'])])

  return new Promise((resolve) => {
    setTimeout(() => {
      for (const s of socks) try { s.close() } catch { /* ignore */ }
      resolve([...found.values()])
    }, opts.timeoutMs ?? 1500)
  })
}
