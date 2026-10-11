import type { ReportRow } from '@shared/reports'
import { SALE_OK, avg, col, returnWhere, saleWhere, totalsOf, type Built, type Ctx, type ReportDef } from './engine'

const n = (v: unknown): number => Number(v) || 0

function customers({ db, f, range }: Ctx): Built {
  const sw = saleWhere(f)
  const search = f.search ? ' AND (c.name LIKE ? OR c.phone LIKE ?)' : ''
  const sp = f.search ? [`%${f.search}%`, `%${f.search}%`] : []
  const sales = db.all<Record<string, unknown>>(
    `SELECT s.customer_id AS cid, COALESCE(c.name,'Walk-in customers') AS name, COALESCE(c.phone,'') AS phone, COALESCE(c.gstin,'') AS gstin,
       COUNT(*) AS bills, SUM(s.total) AS total, MAX(s.created_at) AS last_purchase,
       COALESCE(SUM((SELECT SUM(amount) FROM sale_payments WHERE sale_id = s.id AND method = 'credit')),0) AS credit
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql}${search} GROUP BY s.customer_id`,
    range.fromMs, range.toMs, ...sw.params, ...sp
  )
  const rw = returnWhere(f)
  const rets = db.all<{ cid: number | null; total: number }>(
    `SELECT s.customer_id AS cid, SUM(r.total) AS total FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql}${search} GROUP BY s.customer_id`,
    range.fromMs, range.toMs, ...rw.params, ...sp
  )
  const retBy = new Map<number | null, number>(rets.map((r) => [r.cid, n(r.total)]))
  const rows: ReportRow[] = sales.map((r) => {
    const returned = retBy.get(r.cid == null ? null : n(r.cid)) ?? 0
    return {
      name: String(r.name), phone: String(r.phone), gstin: String(r.gstin), bills: n(r.bills), sales: n(r.total), returns: returned,
      net: n(r.total) - returned, avg_bill: avg(n(r.total), n(r.bills)), credit: n(r.credit), last_purchase: n(r.last_purchase)
    }
  })
  rows.sort((a, b) => n(b.net) - n(a.net))
  const totals = totalsOf(rows, ['bills', 'sales', 'returns', 'net', 'credit'], 'name')
  totals.avg_bill = avg(n(totals.sales), n(totals.bills))
  return {
    columns: [
      col.text('name', 'Customer'), col.text('phone', 'Phone'), col.text('gstin', 'GSTIN'), col.int('bills', 'Bills'), col.money('sales', 'Sales'),
      col.money('returns', 'Returns'), col.money('net', 'Net spend'), col.money('avg_bill', 'Avg bill'), col.money('credit', 'Sold on credit'), col.date('last_purchase', 'Last purchase')
    ],
    rows, totals
  }
}

function audit({ db, f, range }: Ctx): Built {
  const w: string[] = []
  const p: (string | number)[] = []
  if (f.userId != null) { w.push('a.user_id = ?'); p.push(f.userId) }
  if (f.posId != null) { w.push('a.pos_id = ?'); p.push(f.posId) }
  if (f.entity) { w.push('a.entity = ?'); p.push(f.entity) }
  if (f.action) { w.push('a.action = ?'); p.push(f.action) }
  if (f.search) { w.push('(a.note LIKE ? OR a.entity_id LIKE ? OR a.user_name LIKE ?)'); p.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`) }
  const limit = Math.min(f.limit ?? 5000, 100000)
  const raw = db.all<Record<string, unknown>>(
    `SELECT a.id, a.ts, a.user_name, a.pos_code, a.entity, a.entity_id, a.action, a.note FROM audit_log a
     WHERE a.ts BETWEEN ? AND ?${w.length ? ' AND ' + w.join(' AND ') : ''} ORDER BY a.ts DESC, a.id DESC LIMIT ${limit + 1}`,
    range.fromMs, range.toMs, ...p
  )
  const truncated = raw.length > limit
  if (truncated) raw.pop()
  const rows: ReportRow[] = raw.map((r) => ({
    date: n(r.ts), user: String(r.user_name ?? ''), pos: String(r.pos_code ?? ''), entity: String(r.entity), entity_id: String(r.entity_id ?? ''),
    action: String(r.action), note: String(r.note ?? '')
  }))
  return {
    columns: [col.date('date', 'Time', true), col.text('user', 'User'), col.text('pos', 'POS'), col.text('entity', 'Entity'), col.text('entity_id', 'Entity id'), col.text('action', 'Action'), col.text('note', 'Note')],
    rows, truncated
  }
}

export const peopleReports: ReportDef[] = [
  {
    meta: { id: 'customers', title: 'Customer report', group: 'People', description: 'Spend, returns and credit sales per customer', filters: ['preset', 'from', 'to', 'customerId', 'posId', 'search'] },
    build: customers
  },
  {
    meta: { id: 'audit', title: 'Audit log', group: 'Admin', description: 'Search the audit trail by user, entity, action and date (read-only)', filters: ['preset', 'from', 'to', 'userId', 'posId', 'entity', 'action', 'search'] },
    perms: ['audit.view'], build: audit
  }
]
