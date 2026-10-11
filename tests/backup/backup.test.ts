import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { BackupService } from '../../src/main/modules/backup/service'
import { manifestPathFor, sha256File } from '../../src/main/modules/backup/engine'

const apps: App[] = []
const dirs: string[] = []
function mk(): { app: App; svc: BackupService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vbk-'))
  dirs.push(dir)
  const app = createTestApp({ dbPath: join(dir, 'live.db'), userDataDir: dir })
  apps.push(app)
  return { app, svc: app.get<BackupService>('backup'), dir }
}
afterEach(() => {
  for (const a of apps.splice(0)) try { a.db.close() } catch { /* closed */ }
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }) } catch { /* windows locks */ }
})

function seedData(app: App, n = 3, from = 1): void {
  for (let i = from; i < from + n; i++) {
    const p = app.db.run('INSERT INTO products(uuid,name) VALUES (?,?)', app.uuid(), `Item ${i}`)
    const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,price) VALUES (?,?,?,?)', app.uuid(), p.lastId, `SKU${i}`, 1000 * i)
    app.moveStock({ variantId: v.lastId, delta: 10 * i, type: 'opening' })
  }
}
const dump = (app: App) => ({
  products: app.db.all('SELECT * FROM products ORDER BY id'),
  variants: app.db.all('SELECT * FROM product_variants ORDER BY id'),
  levels: app.db.all('SELECT * FROM stock_levels ORDER BY variant_id'),
  moves: app.db.all('SELECT * FROM stock_movements ORDER BY id'),
  settings: app.db.all("SELECT key,value FROM settings WHERE key NOT LIKE 'backup.%' ORDER BY key")
})
const triggers = (app: App) => app.db.value<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'")

describe('backup', () => {
  it('creates a consistent verified backup with manifest and a DB record', () => {
    const { app, svc } = mk()
    seedData(app)
    const r = svc.create({ kind: 'manual' })
    expect(r.verified).toBe(true)
    expect(existsSync(r.path)).toBe(true)
    expect(existsSync(manifestPathFor(r.path))).toBe(true)
    expect(r.manifest.sha256).toBe(sha256File(r.path))
    expect(r.manifest.tables.products).toBe(3)
    expect(r.manifest.schemaVersion).toBeGreaterThanOrEqual(700)
    // no WAL / shm leftovers next to the backup
    expect(readdirSync(join(r.path, '..')).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([])
    const row = svc.list()[0]
    expect(row.verified).toBe(true)
    expect(row.sizeBytes).toBe(r.manifest.sizeBytes)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='backup' AND action='create'")).toBe(1)
    // backup file opens read-only with the same data
    const bk = new DatabaseSync(r.path, { readOnly: true })
    expect((bk.prepare('SELECT COUNT(*) c FROM product_variants').get() as { c: number }).c).toBe(3)
    bk.close()
  })

  it('round trip: restore returns the exact data of the backup and keeps schema/triggers', () => {
    const { app, svc } = mk()
    seedData(app)
    app.setSetting('shop.note', 'before')
    const before = dump(app)
    const trg = triggers(app)
    const b = svc.create({ kind: 'manual' })
    // mutate heavily afterwards
    app.setSetting('shop.note', 'after')
    app.db.run("UPDATE products SET name = 'Changed' WHERE id = 1")
    seedData(app, 2, 10)
    expect(dump(app)).not.toEqual(before)

    const res = svc.restore({ id: b.id })
    expect(res.tablesReplaced).toBeGreaterThan(10)
    expect(res.safetyBackupId).toBeGreaterThan(b.id)
    expect(dump(app)).toEqual(before)
    expect(triggers(app)).toBe(trg)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='backup' AND action='restore'")).toBe(1)
    // history of backups survives, safety backup is verified and holds the pre-restore state
    expect(svc.list().find((x) => x.id === res.safetyBackupId)?.kind).toBe('safety')
    const safety = new DatabaseSync(res.safetyBackupPath, { readOnly: true })
    expect((safety.prepare("SELECT name FROM products WHERE id=1").get() as { name: string }).name).toBe('Changed')
    safety.close()
    // DB still fully usable: stock ledger append works, append-only triggers are active again
    const v = app.db.value<number>('SELECT id FROM product_variants LIMIT 1')!
    app.moveStock({ variantId: v, delta: 1, type: 'adjustment' })
    expect(() => app.db.run('DELETE FROM stock_movements')).toThrow(/append-only/)
    // AUTOINCREMENT counters restored: a new product gets an id after the restored ones
    const np = app.db.run('INSERT INTO products(uuid,name) VALUES (?,?)', app.uuid(), 'New')
    expect(np.lastId).toBe(4)
  })

  it('detects corruption (flipped byte) and refuses to restore it', () => {
    const { app, svc } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    app.db.run("UPDATE products SET name='Live-Edit' WHERE id=1")
    const buf = readFileSync(b.path)
    buf[Math.floor(buf.length / 2)] ^= 0xff
    writeFileSync(b.path, buf)
    const v = svc.verify({ id: b.id })
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/SHA-256/)
    expect(svc.list().find((x) => x.id === b.id)?.verified).toBe(false)
    expect(() => svc.restore({ id: b.id })).toThrow(/failed verification/)
    expect(app.db.value<string>('SELECT name FROM products WHERE id=1')).toBe('Live-Edit') // untouched
  })

  it('refuses a backup without manifest and via exposed API requires typed confirmation', async () => {
    const { app, svc } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    await expect(app.call('backup', 'restore', { id: b.id, confirm: 'nope' })).rejects.toThrow(/RESTORE/)
    const lone = join(tmpdir(), `lone-${Date.now()}.vbak`)
    copyFileSync(b.path, lone)
    try {
      expect(() => svc.restore({ path: lone })).toThrow(/manifest/i)
    } finally {
      rmSync(lone, { force: true })
    }
  })

  it('rolls back completely when the restore fails midway', () => {
    const { app, svc } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    app.db.run("UPDATE products SET name='Live-Edit' WHERE id=1")
    seedData(app, 1, 10)
    const live = dump(app)
    const trg = triggers(app)
    svc.failAtTable = 'sales' // fails after products/stock tables were already replaced
    expect(() => svc.restore({ id: b.id })).toThrow(/Injected failure/)
    svc.failAtTable = undefined
    expect(dump(app)).toEqual(live)
    expect(triggers(app)).toBe(trg)
    expect(app.db.value<string>('PRAGMA foreign_keys')).toBe(1 as never)
    // a clean retry works afterwards (attach was released)
    svc.restore({ id: b.id })
    expect(app.db.value<string>('SELECT name FROM products WHERE id=1')).toBe('Item 1')
  })

  it('refuses a backup from a newer schema', () => {
    const { app, svc, dir } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    const fake = join(dir, 'newer.vbak')
    copyFileSync(b.path, fake)
    const d = new DatabaseSync(fake)
    d.exec("INSERT INTO schema_migrations(version,name,applied_at) VALUES (9999,'future',1)")
    d.close()
    // make the manifest consistent so ONLY the schema check can refuse it
    const m = JSON.parse(readFileSync(manifestPathFor(b.path), 'utf8'))
    m.schemaVersion = 9999
    m.schemaCount += 1
    m.tables.schema_migrations += 1
    m.sha256 = sha256File(fake)
    m.sizeBytes = readFileSync(fake).length
    writeFileSync(manifestPathFor(fake), JSON.stringify(m))
    app.db.run("UPDATE products SET name='Live-Edit' WHERE id=1")
    expect(() => svc.restore({ path: fake })).toThrow(/newer version/)
    expect(app.db.value<string>('SELECT name FROM products WHERE id=1')).toBe('Live-Edit')
  })

  it('restores an older-schema backup (columns missing, tables absent) and re-runs migrations safely', () => {
    const { app, svc, dir } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    const old = join(dir, 'old.vbak')
    copyFileSync(b.path, old)
    const d = new DatabaseSync(old)
    d.exec('DROP TABLE sync_conflicts; DROP TABLE sync_inbox; DELETE FROM schema_migrations WHERE version = 700;')
    d.close()
    const m = JSON.parse(readFileSync(manifestPathFor(b.path), 'utf8'))
    delete m.tables.sync_conflicts
    delete m.tables.sync_inbox
    m.tables.schema_migrations -= 1
    m.schemaCount -= 1
    const od = new DatabaseSync(old, { readOnly: true })
    m.schemaVersion = Number((od.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v)
    od.close()
    m.sha256 = sha256File(old)
    m.sizeBytes = readFileSync(old).length
    writeFileSync(manifestPathFor(old), JSON.stringify(m))
    app.db.run("UPDATE products SET name='Live-Edit' WHERE id=1")
    svc.restore({ path: old })
    expect(app.db.value<string>('SELECT name FROM products WHERE id=1')).toBe('Item 1')
    expect(app.db.value<number>('SELECT COUNT(*) FROM sync_conflicts')).toBe(0) // table still there, emptied
  })

  it('retention keeps the newest N automatic backups only; manual ones stay', () => {
    const { app, svc } = mk()
    seedData(app)
    svc.saveSettings({ retention: 3 })
    const man = svc.create({ kind: 'manual', now: 1_000_000 })
    for (let i = 0; i < 6; i++) svc.create({ kind: 'auto', now: 2_000_000 + i * 1000 })
    const removed = svc.applyRetention()
    expect(removed).toBe(3)
    const left = svc.list()
    expect(left.filter((b) => b.kind === 'auto')).toHaveLength(3)
    expect(left.some((b) => b.id === man.id)).toBe(true)
    expect(left.filter((b) => b.kind === 'auto').every((b) => b.exists)).toBe(true)
    expect(readdirSync(join(man.path, '..')).filter((f) => f.endsWith('.vbak'))).toHaveLength(4)
  })

  it('scheduler: due when never backed up / interval elapsed, copies to the second folder, newest cannot be deleted', () => {
    const { app, svc, dir } = mk()
    seedData(app)
    const copy = join(dir, 'usb')
    svc.saveSettings({ autoEnabled: true, intervalHours: 24, retention: 2, copyFolder: copy })
    const t0 = Date.now()
    expect(svc.isDue(t0)).toBe(true)
    const r = svc.runIfDue(t0)!
    expect(r.manifest.kind).toBe('auto')
    expect(r.copiedTo && existsSync(r.copiedTo)).toBeTruthy()
    expect(svc.isDue(t0 + 3600_000)).toBe(false)
    expect(svc.runIfDue(t0 + 3600_000)).toBeUndefined()
    expect(svc.isDue(t0 + 25 * 3600_000)).toBe(true)
    svc.runIfDue(t0 + 25 * 3600_000)
    svc.runIfDue(t0 + 50 * 3600_000)
    expect(svc.list().filter((b) => b.kind === 'auto')).toHaveLength(2) // retention
    expect(() => svc.delete(svc.list()[0].id)).toThrow(/most recent/)
    svc.saveSettings({ autoEnabled: false })
    expect(svc.isDue(t0 + 999 * 3600_000)).toBe(false)
  })

  it('settings and folder problems are explained in plain words', async () => {
    const { app, svc, dir } = mk()
    seedData(app)
    // a folder name without a drive/path would silently land next to the program files
    expect(() => svc.saveSettings({ folder: 'Backups' })).toThrow(/Backup folder: enter the full path/)
    expect(() => svc.saveSettings({ copyFolder: 'usb\\copies' })).toThrow(/Second copy folder: enter the full path/)
    await expect(app.call('backup', 'saveSettings', { intervalHours: 0 })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/Back up every \(hours\) must be at least 1/) })
    await expect(app.call('backup', 'saveSettings', { retention: 1.5 })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/whole number/) })

    // the backup folder is really a FILE (same effect as a drive that is not there): refused when saving ...
    const blocker = join(dir, 'not-a-folder')
    writeFileSync(blocker, 'x')
    const bad = join(blocker, 'backups')
    expect(() => svc.saveSettings({ folder: bad })).toThrow(/cannot be used .*choose another folder/i)
    expect(svc.getSettings().folder).toBe(svc.defaultFolder()) // nothing was saved

    // ... and if it breaks later, the automatic backup records a readable reason instead of a raw ENOENT/ENOTDIR line
    app.setSetting('backup.folder', bad)
    expect(svc.runIfDue(Date.now())).toBeUndefined()
    const err = app.setting('backup.last_error', '')
    expect(err).toMatch(/^The backup folder ".*" cannot be used \(E[A-Z]+\)\. Connect that drive, or choose another folder/)
    expect(svc.list()).toHaveLength(0)

    // a good folder works again and clears the error
    expect(svc.saveSettings({ folder: join(dir, 'good') }).folder).toBe(join(dir, 'good'))
    expect(svc.runIfDue(Date.now())!.verified).toBe(true)
    expect(app.setting('backup.last_error', '')).toBe('')
  })

  it('restore keeps the signed-in user working with the permissions stored in the restored data', async () => {
    const { app, svc } = mk()
    seedData(app)
    const b = svc.create({ kind: 'manual' })
    // after the backup the Owner role is (wrongly) cut down in the live database and the session picked that up
    app.session = { ...app.session!, permissions: ['pos.sell'], role: 'Owner' }
    const r = svc.restore({ id: b.id })
    expect(r.reloginRequired).toBe(false)
    expect(app.session!.permissions).toEqual(['*'])
    await expect(app.call('backup', 'list')).resolves.toBeTruthy()
  })

  it('service permission: cashier cannot back up', async () => {
    const { app } = mk()
    const { actAs } = await import('../helpers')
    actAs(app, 'Cashier')
    await expect(app.call('backup', 'create', {})).rejects.toThrow(/Permission/)
  })
})
