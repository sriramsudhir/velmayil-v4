/**
 * Minimal logic-less template engine ({{var}}, {{{raw}}}, {{#section}}...{{/section}}, {{^inverse}}...{{/inverse}}).
 * Every {{var}} is HTML-escaped unless the value is a `Safe` (pre-rendered, trusted markup such as the logo <img>).
 * Pure and dependency free so it can be unit-tested under plain Node.
 */

export class Safe {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html
  }
}

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!)

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string; raw: boolean }
  | { t: 'sec'; path: string; inverse: boolean; children: Node[] }

const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#^/])?\s*([^}]+?)\s*\}\}/g

export function parseTemplate(tpl: string): Node[] {
  const root: Node[] = []
  const stack: { path: string; children: Node[] }[] = []
  let cur = root
  let last = 0
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(tpl))) {
    if (m.index > last) cur.push({ t: 'text', v: tpl.slice(last, m.index) })
    last = m.index + m[0].length
    if (m[1] !== undefined) cur.push({ t: 'var', path: m[1], raw: true })
    else if (m[2] === '#' || m[2] === '^') {
      const node: Node = { t: 'sec', path: m[3], inverse: m[2] === '^', children: [] }
      cur.push(node)
      stack.push({ path: m[3], children: cur })
      cur = node.children
    } else if (m[2] === '/') {
      const top = stack.pop()
      if (!top || top.path !== m[3]) throw new Error(`Template error: unexpected {{/${m[3]}}}`)
      cur = top.children
    } else cur.push({ t: 'var', path: m[3], raw: false })
  }
  if (stack.length) throw new Error(`Template error: unclosed {{#${stack[stack.length - 1].path}}}`)
  if (last < tpl.length) cur.push({ t: 'text', v: tpl.slice(last) })
  return root
}

function lookup(path: string, stack: unknown[]): unknown {
  if (path === '.' || path === 'this') return stack[stack.length - 1]
  const parts = path.split('.')
  for (let i = stack.length - 1; i >= 0; i--) {
    let v: any = stack[i]
    if (v === null || typeof v !== 'object' || !(parts[0] in v)) continue
    for (const p of parts) {
      if (v === null || v === undefined || typeof v !== 'object') { v = undefined; break }
      v = v[p]
    }
    return v
  }
  return undefined
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0))

function renderNodes(nodes: Node[], stack: unknown[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') out += n.v
    else if (n.t === 'var') {
      const v = lookup(n.path, stack)
      out += v instanceof Safe ? v.html : n.raw ? String(v ?? '') : esc(v)
    } else {
      const v = lookup(n.path, stack)
      if (n.inverse) {
        if (!truthy(v)) out += renderNodes(n.children, stack)
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          const ctx = item !== null && typeof item === 'object' ? { _index: i + 1, ...item } : { _index: i + 1, '.': item }
          out += renderNodes(n.children, [...stack, ctx])
        })
      } else if (truthy(v)) out += renderNodes(n.children, v !== null && typeof v === 'object' ? [...stack, v] : stack)
    }
  }
  return out
}

export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return renderNodes(parseTemplate(tpl), [data])
}
