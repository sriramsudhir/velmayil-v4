import type { ReportRow } from '@shared/reports'
import {
  SALE_OK, SALE_VOID, avg, bp, col, dayExpr, hourExpr, lineNeeds, lineWhere, linesCte, monthExpr, returnWhere, saleWhere, totalsOf,
  type Built, type Ctx, type ReportDef
} from './engine'

type Num = number
const n = (v: unknown): number => Number(v) || 0

// ============================================================ sales summary
interface HdrAgg { b: string; bills: Num; subtotal: Num; discount: Num; tax: Num; round_off: Num; total: Num }
interface RetAgg { b: string; cnt: Num; total: Num }

function salesSummary({ db, f, range }: Ctx): Built {
  const gb = f.groupBy === 'hour' || f.groupBy === 'month' ? f.groupBy : 'day'
  const bucket = gb === 'hour' ? hourExpr : gb === 'month' ? monthExpr : dayExpr
  const sw = saleWhere(f)
  const sales = db.all<HdrAgg>(
    `SELECT ${bucket('s.created_at')} AS b, COUNT(*) AS bills, SUM(s.subtotal) AS subtotal, SUM(s.discount) AS discount, SUM(s.tax) AS tax,
            SUM(s.round_off) AS round_off, SUM(s.total) AS total
     FROM sales s WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql} GROUP BY b`,
    range.fromMs, range.toMs, ...sw.params
  )
  const rw = returnWhere(f)
  const rets = db.all<RetAgg>(
    `SELECT ${bucket('r.created_at')} AS b, COUNT(*) AS cnt, SUM(r.total) AS total
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql} GROUP BY b`,
    range.fromMs, range.toMs, ...rw.params
  )
  const map = new Map<string, ReportRow>()
  const get = (b: string): ReportRow => {
    let r = map.get(b)
    if (!r) {
      r = { period: gb === 'hour' ? `${b}:00` : b, bills: 0, subtotal: 0, discount: 0, taxable: 0, tax: 0, round_off: 0, total: 0, returns_count: 0, returns: 0, net_total: 0, avg_bill: 0 }
      map.set(b, r)
    }
    return r
  }
  for (const s of sales) {
    const r = get(s.b)
    r.bills = n(s.bills); r.subtotal = n(s.subtotal); r.discount = n(s.discount); r.tax = n(s.tax); r.round_off = n(s.round_off); r.total = n(s.total)
    r.taxable = n(s.total) - n(s.tax) - n(s.round_off)
  }
  for (const x of rets) {
    const r = get(x.b)
    r.returns_count = n(x.cnt); r.returns = n(x.total)
  }
  const rows = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => {
    r.net_total = n(r.total) - n(r.returns)
    r.avg_bill = avg(n(r.total), n(r.bills))
    return r
  })
  const totals = totalsOf(rows, ['bills', 'subtotal', 'discount', 'taxable', 'tax', 'round_off', 'total', 'returns_count', 'returns', 'net_total'], 'period')
  totals.avg_bill = avg(n(totals.total), n(totals.bills))
  return {
    subtitle: `By ${gb}`,
    columns: [
      col.text('period', gb === 'hour' ? 'Hour' : gb === 'month' ? 'Month' : 'Date'), col.int('bills', 'Bills'), col.money('subtotal', 'Subtotal'),
      col.money('discount', 'Discount'), col.money('taxable', 'Taxable value'), col.money('tax', 'Tax'), col.money('round_off', 'Round-off'),
      col.money('total', 'Sales'), col.int('returns_count', 'Returns'), col.money('returns', 'Returns value'), col.money('net_total', 'Net sales'),
      col.money('avg_bill', 'Avg bill')
    ],
    rows, totals
  }
}

// ============================================================ sales detail
function salesDetail({ db, f, range }: Ctx): Built {
  const sw = saleWhere(f)
  const limit = Math.min(f.limit ?? 20000, 200000)
  const rows = db.all<Record<string, unknown>>(
    `SELECT s.id, s.invoice_no, s.created_at, pt.name AS pos, u.name AS cashier, COALESCE(c.name,'Walk-in') AS customer,
            (SELECT COALESCE(SUM(qty),0) FROM sale_items WHERE sale_id = s.id) AS qty,
            s.subtotal, s.discount, s.tax, s.round_off, s.total,
            (SELECT group_concat(method || ' ' || printf('%.2f', amount / 100.0), ', ') FROM (SELECT method, amount FROM sale_payments WHERE sale_id = s.id ORDER BY id)) AS payments,
            (SELECT COALESCE(SUM(total),0) FROM sale_returns WHERE sale_id = s.id) AS returned
     FROM sales s LEFT JOIN pos_terminals pt ON pt.id = s.pos_id LEFT JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql} ORDER BY s.created_at, s.id LIMIT ${limit + 1}`,
    range.fromMs, range.toMs, ...sw.params
  )
  const truncated = rows.length > limit
  if (truncated) rows.pop()
  const out: ReportRow[] = rows.map((r) => ({
    invoice: String(r.invoice_no), date: n(r.created_at), pos: String(r.pos ?? ''), cashier: String(r.cashier ?? ''), customer: String(r.customer),
    qty: n(r.qty), subtotal: n(r.subtotal), discount: n(r.discount), tax: n(r.tax), round_off: n(r.round_off), total: n(r.total),
    returned: n(r.returned), payments: String(r.payments ?? ''), _saleId: n(r.id)
  }))
  return {
    columns: [
      col.text('invoice', 'Invoice'), col.date('date', 'Date', true), col.text('pos', 'POS'), col.text('cashier', 'Cashier'), col.text('customer', 'Customer'),
      col.int('qty', 'Qty'), col.money('subtotal', 'Subtotal'), col.money('discount', 'Discount'), col.money('tax', 'Tax'), col.money('round_off', 'Round-off'),
      col.money('total', 'Total'), col.money('returned', 'Returned'), col.text('payments', 'Payments')
    ],
    rows: out, totals: totalsOf(out, ['qty', 'subtotal', 'discount', 'tax', 'round_off', 'total', 'returned'], 'invoice'), truncated
  }
}

// ============================================================ line-based group reports (item / category / brand / profit)
interface GroupOpts {
  key: string            // SQL expression on `l`
  joins?: string         // extra joins for the display name
  nameExpr: string       // SQL expression for the label
  extra?: { key: string; header: string; expr: string }[]
  firstCol: { key: string; header: string }
  order?: string
  profit: boolean
  shareOfTotal?: boolean
}

function groupLines(ctx: Ctx, o: GroupOpts): Built {
  const { db, f, range, canProfit } = ctx
  const lw = lineWhere(f)
  const extraSel = (o.extra ?? []).map((e) => `, ${e.expr} AS ${e.key}`).join('')
  const raw = db.all<Record<string, unknown>>(
    `WITH ${linesCte(range.fromMs, range.toMs, lineNeeds(o.key, o.nameExpr, o.joins ?? '', lw.sql, ...(o.extra ?? []).map((e) => e.expr)))}
     SELECT ${o.key} AS gk, ${o.nameExpr} AS label${extraSel},
       SUM(CASE WHEN l.kind='S' THEN l.qty ELSE 0 END) AS qty_sold, -SUM(CASE WHEN l.kind='R' THEN l.qty ELSE 0 END) AS qty_returned,
       SUM(l.qty) AS qty_net, SUM(l.discount) AS discount, SUM(l.total - l.tax) AS taxable, SUM(l.tax) AS tax, SUM(l.total) AS total, SUM(l.cost) AS cost
     FROM lines l ${o.joins ?? ''} WHERE 1=1${lw.sql} GROUP BY gk ORDER BY ${o.order ?? 'total DESC'}`,
    ...lw.params
  )
  const grand = raw.reduce((a, r) => a + n(r.total), 0)
  const rows: ReportRow[] = raw.map((r) => {
    const row: ReportRow = { [o.firstCol.key]: String(r.label ?? '') }
    for (const e of o.extra ?? []) row[e.key] = (r[e.key] as string | number | null) ?? ''
    row.qty_sold = n(r.qty_sold); row.qty_returned = n(r.qty_returned); row.qty_net = n(r.qty_net)
    row.discount = n(r.discount); row.taxable = n(r.taxable); row.tax = n(r.tax); row.total = n(r.total)
    if (o.shareOfTotal) row.share = bp(n(r.total), grand)
    if (o.profit && canProfit) {
      row.cost = n(r.cost); row.profit = n(r.taxable) - n(r.cost); row.margin = bp(n(r.taxable) - n(r.cost), n(r.taxable))
    }
    return row
  })
  const sumKeys = ['qty_sold', 'qty_returned', 'qty_net', 'discount', 'taxable', 'tax', 'total']
  if (o.profit && canProfit) sumKeys.push('cost', 'profit')
  if (o.shareOfTotal) sumKeys.push('share')
  const totals = totalsOf(rows, sumKeys, o.firstCol.key)
  if (o.shareOfTotal) totals.share = grand ? 10000 : 0
  if (o.profit && canProfit) totals.margin = bp(n(totals.profit), n(totals.taxable))
  const columns = [
    col.text(o.firstCol.key, o.firstCol.header),
    ...(o.extra ?? []).map((e) => col.text(e.key, e.header)),
    col.int('qty_sold', 'Qty sold'), col.int('qty_returned', 'Qty returned'), col.int('qty_net', 'Net qty'),
    col.money('discount', 'Discount'), col.money('taxable', 'Net sales (ex-tax)'), col.money('tax', 'Tax'), col.money('total', 'Net total')
  ]
  if (o.shareOfTotal) columns.push(col.pct('share', 'Share'))
  if (o.profit && canProfit) columns.push(col.money('cost', 'Cost'), col.money('profit', 'Profit'), col.pct('margin', 'Margin'))
  return { columns, rows, totals }
}

const itemSales = (ctx: Ctx): Built =>
  groupLines(ctx, {
    key: 'l.variant_id', nameExpr: 'MAX(l.name)', firstCol: { key: 'name', header: 'Product' }, profit: true,
    extra: [{ key: 'sku', header: 'SKU', expr: 'MAX(l.sku)' }, { key: 'hsn', header: 'HSN', expr: 'MAX(l.hsn)' }]
  })

const categorySales = (ctx: Ctx): Built =>
  groupLines(ctx, {
    key: 'COALESCE(l.category_id,0)', joins: 'LEFT JOIN categories cg ON cg.id = l.category_id', nameExpr: `COALESCE(MAX(cg.name),'Uncategorised')`,
    firstCol: { key: 'category', header: 'Category' }, profit: true, shareOfTotal: true
  })

const brandSales = (ctx: Ctx): Built =>
  groupLines(ctx, {
    key: 'COALESCE(l.brand_id,0)', joins: 'LEFT JOIN brands bd ON bd.id = l.brand_id', nameExpr: `COALESCE(MAX(bd.name),'No brand')`,
    firstCol: { key: 'brand', header: 'Brand' }, profit: true, shareOfTotal: true
  })

// ============================================================ profit & margin (reports.profit)
function profit(ctx: Ctx): Built {
  const gb = ['product', 'category', 'brand'].includes(ctx.f.groupBy ?? '') ? ctx.f.groupBy! : 'day'
  if (gb === 'product') return { ...itemSales(ctx), subtitle: 'By product' }
  if (gb === 'category') return { ...categorySales(ctx), subtitle: 'By category' }
  if (gb === 'brand') return { ...brandSales(ctx), subtitle: 'By brand' }
  const b = groupLines(ctx, {
    key: dayExpr('l.ts'), nameExpr: dayExpr('MIN(l.ts)'), firstCol: { key: 'period', header: 'Date' }, profit: true, order: 'gk'
  })
  return { ...b, subtitle: 'By day' }
}

// ============================================================ payment methods (+ reconciliation)
export interface PayRow { method: string; bills: number; received: number; change: number; refunds_count: number; refunds: number; net: number }
function paymentMethods({ db, f, range }: Ctx): Built {
  const sw = saleWhere(f)
  const recv = db.all<{ method: string; bills: number; amount: number }>(
    `SELECT sp.method AS method, COUNT(DISTINCT s.id) AS bills, SUM(sp.amount) AS amount
     FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql} GROUP BY sp.method`,
    range.fromMs, range.toMs, ...sw.params
  )
  const change = n(db.value<number>(`SELECT COALESCE(SUM(s.change_given),0) FROM sales s WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql}`, range.fromMs, range.toMs, ...sw.params))
  const rw = returnWhere(f)
  const refs = db.all<{ method: string; cnt: number; amount: number }>(
    `SELECT r.refund_method AS method, COUNT(*) AS cnt, SUM(r.total) AS amount
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.refund_method <> 'original' AND r.created_at BETWEEN ? AND ?${rw.sql} GROUP BY r.refund_method`,
    range.fromMs, range.toMs, ...rw.params
  )
  // "original" is not a payment method: the cash part (refund_cash) left the drawer, the rest went back the way the bill was paid
  const orig = db.all<{ sale_id: number; amount: number; cash: number }>(
    `SELECT r.sale_id AS sale_id, r.total AS amount, r.refund_cash AS cash
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.refund_method = 'original' AND r.created_at BETWEEN ? AND ?${rw.sql}`,
    range.fromMs, range.toMs, ...rw.params
  )
  const nonCash = new Map<number, { method: string; amount: number }[]>()
  const saleIds = [...new Set(orig.map((o) => n(o.sale_id)))]
  for (let i = 0; i < saleIds.length; i += 500) {
    const chunk = saleIds.slice(i, i + 500)
    for (const p of db.all<{ sale_id: number; method: string; amount: number }>(
      `SELECT sale_id, method, SUM(amount) AS amount FROM sale_payments WHERE method <> 'cash' AND sale_id IN (${chunk.map(() => '?').join(',')}) GROUP BY sale_id, method ORDER BY sale_id, method`,
      ...chunk
    )) {
      const list = nonCash.get(n(p.sale_id)) ?? []
      list.push({ method: p.method, amount: n(p.amount) })
      nonCash.set(n(p.sale_id), list)
    }
  }
  const map = new Map<string, ReportRow>()
  const get = (m: string): ReportRow => {
    let r = map.get(m)
    if (!r) { r = { method: m, bills: 0, received: 0, change: 0, refunds_count: 0, refunds: 0, net: 0 }; map.set(m, r) }
    return r
  }
  for (const x of recv) { const r = get(x.method); r.bills = n(x.bills); r.received = n(x.amount) }
  if (change) get('cash').change = change
  for (const x of refs) { const r = get(x.method); r.refunds_count = n(x.cnt); r.refunds = n(x.amount) }
  for (const o of orig) {
    const pays = nonCash.get(n(o.sale_id)) ?? []
    const paySum = pays.reduce((a, p) => a + p.amount, 0)
    // nothing but cash was paid (or the payments are unknown): all of it is cash
    const cash = paySum > 0 ? Math.min(n(o.amount), Math.max(0, n(o.cash))) : n(o.amount)
    const parts: { method: string; amount: number }[] = cash > 0 ? [{ method: 'cash', amount: cash }] : []
    let left = n(o.amount) - cash
    pays.forEach((p, i) => {
      const part = i === pays.length - 1 ? left : Math.min(left, Math.round(((n(o.amount) - cash) * p.amount) / paySum))
      left -= part
      if (part > 0) parts.push({ method: p.method, amount: part })
    })
    for (const p of parts) get(p.method).refunds = n(get(p.method).refunds) + p.amount
    // one refund is counted once, on the method that carried most of it
    const main = parts.reduce<{ method: string; amount: number } | null>((a, p) => (!a || p.amount > a.amount ? p : a), null)
    const row = get(main?.method ?? 'cash')
    row.refunds_count = n(row.refunds_count) + 1
  }
  const order = ['cash', 'upi', 'card', 'credit', 'other']
  const rows = [...map.values()].sort((a, b) => {
    const ia = order.indexOf(String(a.method)), ib = order.indexOf(String(b.method))
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.method).localeCompare(String(b.method))
  })
  for (const r of rows) r.net = n(r.received) - n(r.refunds)
  return {
    columns: [
      col.text('method', 'Method'), col.int('bills', 'Bills'), col.money('received', 'Collected (net of change)'), col.money('change', 'Change given (memo)'),
      col.int('refunds_count', 'Refunds'), col.money('refunds', 'Refunded'), col.money('net', 'Net collections')
    ],
    rows, totals: totalsOf(rows, ['bills', 'received', 'change', 'refunds_count', 'refunds', 'net'], 'method'),
    notes: ['Payments are stored net of change (sum = bill total), so collected already excludes change; the change column is a memo. Net collections = collected - refunds. Credit is an amount receivable, not cash in hand. Sum of net equals sales total minus returns.']
  }
}

// ============================================================ POS-wise / cashier-wise
function perActor(ctx: Ctx, kind: 'pos' | 'cashier'): Built {
  const { db, f, range } = ctx
  const sCol = kind === 'pos' ? 's.pos_id' : 's.user_id'
  const rCol = kind === 'pos' ? 'r.pos_id' : 'r.user_id'
  const sw = saleWhere(f)
  const sales = db.all<Record<string, unknown>>(
    `SELECT ${sCol} AS k, COUNT(*) AS bills, SUM(s.subtotal) AS subtotal, SUM(s.discount) AS discount, SUM(s.tax) AS tax, SUM(s.total) AS total
     FROM sales s WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql} GROUP BY k`,
    range.fromMs, range.toMs, ...sw.params
  )
  const rw = returnWhere(f)
  const rets = db.all<Record<string, unknown>>(
    `SELECT ${rCol} AS k, COUNT(*) AS cnt, SUM(r.total) AS total
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql} GROUP BY k`,
    range.fromMs, range.toMs, ...rw.params
  )
  const names = new Map<number, string>(
    kind === 'pos'
      ? db.all<{ id: number; name: string; code: string }>('SELECT id, name, code FROM pos_terminals').map((x) => [x.id, `${x.name} (${x.code})`] as [number, string])
      : db.all<{ id: number; name: string }>('SELECT id, name FROM users').map((x) => [x.id, x.name] as [number, string])
  )
  const map = new Map<number, ReportRow>()
  const get = (k: number): ReportRow => {
    let r = map.get(k)
    if (!r) {
      r = { name: names.get(k) ?? `#${k}`, bills: 0, subtotal: 0, discount: 0, tax: 0, total: 0, returns_count: 0, returns: 0, net_total: 0, avg_bill: 0 }
      map.set(k, r)
    }
    return r
  }
  for (const s of sales) {
    const r = get(n(s.k)); r.bills = n(s.bills); r.subtotal = n(s.subtotal); r.discount = n(s.discount); r.tax = n(s.tax); r.total = n(s.total)
  }
  for (const x of rets) { const r = get(n(x.k)); r.returns_count = n(x.cnt); r.returns = n(x.total) }
  const rows = [...map.values()]
  for (const r of rows) { r.net_total = n(r.total) - n(r.returns); r.avg_bill = avg(n(r.total), n(r.bills)) }
  rows.sort((a, b) => n(b.net_total) - n(a.net_total))
  const totals = totalsOf(rows, ['bills', 'subtotal', 'discount', 'tax', 'total', 'returns_count', 'returns', 'net_total'], 'name')
  totals.avg_bill = avg(n(totals.total), n(totals.bills))
  return {
    columns: [
      col.text('name', kind === 'pos' ? 'POS' : 'Cashier'), col.int('bills', 'Bills'), col.money('subtotal', 'Subtotal'), col.money('discount', 'Discount'),
      col.money('tax', 'Tax'), col.money('total', 'Sales'), col.int('returns_count', 'Returns'), col.money('returns', 'Returns value'),
      col.money('net_total', 'Net sales'), col.money('avg_bill', 'Avg bill')
    ],
    rows, totals,
    notes: ['Sales are attributed to the bill\'s POS/cashier; returns to the POS/cashier that processed them.']
  }
}

// ============================================================ shift-wise cash reconciliation
function shiftCash({ db, f, range }: Ctx): Built {
  const w: string[] = []
  const p: (string | number)[] = []
  if (f.posId != null) { w.push('sh.pos_id = ?'); p.push(f.posId) }
  if (f.userId != null) { w.push('sh.user_id = ?'); p.push(f.userId) }
  const raw = db.all<Record<string, unknown>>(
    `SELECT sh.id, sh.opened_at, sh.closed_at, sh.opening_cash, sh.closing_cash, pt.name AS pos, u.name AS cashier,
       (SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id AND ${SALE_OK}) AS bills,
       (SELECT COALESCE(SUM(sp.amount),0) FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.shift_id = sh.id AND sp.method = 'cash' AND s.status NOT IN ('cancelled','held','draft')) AS cash_in,
       (SELECT COALESCE(SUM(sp.amount),0) FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE sp.method = 'cash' AND ${SALE_VOID}
          AND COALESCE(s.void_shift_id, s.shift_id) = sh.id) AS cash_voided,
       (SELECT COALESCE(SUM(CASE WHEN r.refund_method = 'cash' THEN r.total ELSE r.refund_cash END),0) FROM sale_returns r WHERE r.shift_id = sh.id) AS cash_refunds
     FROM shifts sh LEFT JOIN pos_terminals pt ON pt.id = sh.pos_id LEFT JOIN users u ON u.id = sh.user_id
     WHERE sh.opened_at BETWEEN ? AND ?${w.length ? ' AND ' + w.join(' AND ') : ''} ORDER BY sh.opened_at, sh.id`,
    range.fromMs, range.toMs, ...p
  )
  const rows: ReportRow[] = raw.map((r) => {
    const cashSales = n(r.cash_in) - n(r.cash_voided)
    const expected = n(r.opening_cash) + cashSales - n(r.cash_refunds)
    const counted = r.closing_cash == null ? null : n(r.closing_cash)
    return {
      shift: `#${r.id}`, pos: String(r.pos ?? ''), cashier: String(r.cashier ?? ''), opened: n(r.opened_at), closed: r.closed_at == null ? null : n(r.closed_at),
      bills: n(r.bills), opening_cash: n(r.opening_cash), cash_sales: cashSales, cash_refunds: n(r.cash_refunds), expected,
      counted, variance: counted == null ? null : counted - expected
    }
  })
  const totals = totalsOf(rows, ['bills', 'opening_cash', 'cash_sales', 'cash_refunds', 'expected'], 'shift')
  totals.counted = rows.reduce((a, r) => a + n(r.counted), 0)
  totals.variance = rows.reduce((a, r) => a + n(r.variance), 0)
  return {
    columns: [
      col.text('shift', 'Shift'), col.text('pos', 'POS'), col.text('cashier', 'Cashier'), col.date('opened', 'Opened', true), col.date('closed', 'Closed', true),
      col.int('bills', 'Bills'), col.money('opening_cash', 'Opening cash'), col.money('cash_sales', 'Cash sales (net of change)'),
      col.money('cash_refunds', 'Cash refunds'), col.money('expected', 'Expected cash'), col.money('counted', 'Counted cash'), col.money('variance', 'Over / short')
    ],
    rows, totals, notes: ['Expected cash = opening cash + cash sales (payments are stored net of change) - cash refunds. Open shifts have no counted cash.']
  }
}

// ============================================================ discounts
function discounts({ db, f, range }: Ctx): Built {
  const sw = saleWhere(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT s.id, s.invoice_no, s.created_at, u.name AS cashier, COALESCE(c.name,'Walk-in') AS customer, s.subtotal, s.discount,
       (SELECT COALESCE(SUM(discount),0) FROM sale_items WHERE sale_id = s.id) AS line_discount,
       (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id AND price_overridden = 1) AS overrides,
       (SELECT u2.name FROM approvals a JOIN users u2 ON u2.id = a.approved_by
          WHERE a.entity IN ('sale','sales') AND a.entity_id IN (CAST(s.id AS TEXT), s.invoice_no, s.uuid) ORDER BY a.id DESC LIMIT 1) AS approved_by
     FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${SALE_OK} AND s.created_at BETWEEN ? AND ?${sw.sql}
       AND (s.discount > 0 OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND (si.discount > 0 OR si.price_overridden = 1)))
     ORDER BY s.created_at, s.id`,
    range.fromMs, range.toMs, ...sw.params
  )
  const rows: ReportRow[] = raw.map((r) => ({
    invoice: String(r.invoice_no), date: n(r.created_at), cashier: String(r.cashier ?? ''), customer: String(r.customer), subtotal: n(r.subtotal),
    discount: n(r.discount), discount_pct: bp(n(r.discount), n(r.subtotal)), line_discount: n(r.line_discount), overrides: n(r.overrides),
    approved_by: String(r.approved_by ?? ''), _saleId: n(r.id)
  }))
  const totals = totalsOf(rows, ['subtotal', 'discount', 'line_discount', 'overrides'], 'invoice')
  totals.discount_pct = bp(n(totals.discount), n(totals.subtotal))
  return {
    columns: [
      col.text('invoice', 'Invoice'), col.date('date', 'Date', true), col.text('cashier', 'Given by'), col.text('customer', 'Customer'),
      col.money('subtotal', 'Subtotal'), col.money('discount', 'Total discount'), col.pct('discount_pct', 'Discount %'),
      col.money('line_discount', 'of which line discounts'), col.int('overrides', 'Price overrides'), col.text('approved_by', 'Approved by')
    ],
    rows, totals
  }
}

// ============================================================ returns & refunds
function returns({ db, f, range }: Ctx): Built {
  const rw = returnWhere(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT r.id, r.return_no, r.created_at, s.id AS sale_id, s.invoice_no, u.name AS cashier, r.reason, r.refund_method, r.subtotal, r.tax, r.total
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id
     WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql} ORDER BY r.created_at, r.id`,
    range.fromMs, range.toMs, ...rw.params
  )
  const rows: ReportRow[] = raw.map((r) => ({
    return_no: String(r.return_no), date: n(r.created_at), invoice: String(r.invoice_no), cashier: String(r.cashier ?? ''), reason: String(r.reason ?? ''),
    method: String(r.refund_method), subtotal: n(r.subtotal), tax: n(r.tax), total: n(r.total), _saleId: n(r.sale_id)
  }))
  return {
    columns: [
      col.text('return_no', 'Return no'), col.date('date', 'Date', true), col.text('invoice', 'Original invoice'), col.text('cashier', 'Processed by'),
      col.text('reason', 'Reason'), col.text('method', 'Refund method'), col.money('subtotal', 'Subtotal'), col.money('tax', 'Tax'), col.money('total', 'Refund')
    ],
    rows, totals: totalsOf(rows, ['subtotal', 'tax', 'total'], 'return_no')
  }
}

// ============================================================ voided sales
function voided({ db, f, range }: Ctx): Built {
  const sw = saleWhere(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT s.id, s.invoice_no, s.created_at, s.voided_at, s.void_reason, u.name AS cashier, vu.name AS voided_by_name, s.total
     FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users vu ON vu.id = s.voided_by
     WHERE ${SALE_VOID} AND COALESCE(s.voided_at, s.created_at) BETWEEN ? AND ?${sw.sql} ORDER BY COALESCE(s.voided_at, s.created_at), s.id`,
    range.fromMs, range.toMs, ...sw.params
  )
  const rows: ReportRow[] = raw.map((r) => ({
    invoice: String(r.invoice_no), date: n(r.created_at), voided_at: r.voided_at == null ? null : n(r.voided_at), cashier: String(r.cashier ?? ''),
    voided_by: String(r.voided_by_name ?? ''), reason: String(r.void_reason ?? ''), total: n(r.total), _saleId: n(r.id)
  }))
  return {
    columns: [
      col.text('invoice', 'Invoice'), col.date('date', 'Sale date', true), col.date('voided_at', 'Voided at', true), col.text('cashier', 'Cashier'),
      col.text('voided_by', 'Voided by'), col.text('reason', 'Reason'), col.money('total', 'Amount')
    ],
    rows, totals: totalsOf(rows, ['total'], 'invoice'),
    notes: ['Voided sales are excluded from every other sales, tax and profit report.']
  }
}

const meta = (id: string, title: string, description: string, filters: ReportDef['meta']['filters'], extra: Partial<ReportDef['meta']> = {}): ReportDef['meta'] =>
  ({ id, title, group: 'Sales', description, filters, ...extra })

const COMMON = ['preset', 'from', 'to', 'posId', 'userId', 'categoryId', 'brandId', 'paymentMethod', 'customerId', 'productId'] as const
const HDR = [...COMMON] as ReportDef['meta']['filters']

export const salesReports: ReportDef[] = [
  { meta: meta('sales_summary', 'Sales summary', 'Sales, discounts, tax and returns by day, hour or month', [...HDR, 'groupBy']), build: salesSummary },
  { meta: meta('sales_detail', 'Sales detail (invoices)', 'Every invoice in the period with payments and returns', HDR), build: salesDetail },
  { meta: meta('item_sales', 'Item-wise sales', 'Quantity, revenue, discount, tax and profit per product', HDR), build: itemSales },
  { meta: meta('category_sales', 'Category-wise sales', 'Sales and profit per category', HDR), build: categorySales },
  { meta: meta('brand_sales', 'Brand-wise sales', 'Sales and profit per brand', HDR), build: brandSales },
  { meta: meta('payment_methods', 'Payment methods', 'Collections by cash / UPI / card / credit, change and refunds', HDR), build: paymentMethods },
  { meta: meta('pos_wise', 'POS-wise sales', 'Sales per POS terminal', HDR), build: (c) => perActor(c, 'pos') },
  { meta: meta('cashier_wise', 'Cashier-wise sales', 'Sales per cashier', HDR), build: (c) => perActor(c, 'cashier') },
  { meta: meta('shift_cash', 'Shift cash reconciliation', 'Opening, cash sales, refunds, expected and counted cash per shift', ['preset', 'from', 'to', 'posId', 'userId']), build: shiftCash },
  { meta: meta('discounts', 'Discount report', 'Who gave what discount, price overrides and approvals', HDR), build: discounts },
  { meta: meta('returns', 'Returns & refunds', 'Sales returns and refund methods', HDR), build: returns },
  { meta: meta('voided', 'Voided sales', 'Cancelled invoices with reasons', HDR), build: voided },
  {
    meta: meta('profit', 'Profit & margin', 'Revenue, cost, profit and margin using cost captured at sale time', [...HDR, 'groupBy'], { needsProfit: true }),
    perms: ['reports.profit'], build: profit
  }
]
