import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { call } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useLiveRefresh } from '@/lib/live'
import type { DashboardSummary } from '@shared/reports'
import {
  BarChart, Button, Card, EmptyState, ErrorState, HBarList, InlineAlert, PageHeader, Skeleton, StatCard, Tabs, TrendChart, useAsync, useInterval,
  formatDateTime, formatDayMonth, formatMoney, formatMoneyCompact, formatNumber, pctChange, relativeTime, startOfDayIST, Badge
} from '@/ui'
import { DeleteSaleDialog, TrashIcon } from '@/modules/pos/DeleteSaleDialog'
import './dashboard.css'

type RecentSale = DashboardSummary['recentSales'][number]

const REFRESH_MS = 60_000
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`
const dayLabel = (d: string) => formatDayMonth(startOfDayIST(d))

function Dashboard() {
  const { can, session } = useSession()
  const navigate = useNavigate()
  const [range, setRange] = useState<'7' | '30'>('7')
  const { data, loading, error, reload } = useAsync<DashboardSummary>(() => call<DashboardSummary>('dashboard', 'summary', {}), [])
  useInterval(reload, REFRESH_MS, { onFocus: true })
  // a bill saved, voided, returned or deleted on any screen / window / synced terminal shows up at once
  useLiveRefresh(['pos', 'inventory', 'purchases'], reload)
  const [deleting, setDeleting] = useState<RecentSale | null>(null)
  const canDelete = can('pos.delete')

  const d = data
  const first = loading && !d
  const showProfit = can('reports.profit') && d?.today.grossProfit != null

  const trend = useMemo(() => {
    const src = (range === '7' ? d?.last7 : d?.last30) ?? []
    return src.map((x) => ({ label: dayLabel(x.date), value: x.sales }))
  }, [d, range])

  const hourly = useMemo(() => {
    const bills = new Array<number>(24).fill(0)
    for (const h of d?.heatmap ?? []) bills[h.hour] = (bills[h.hour] ?? 0) + h.bills
    const nz = bills.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)
    if (!nz.length) return { points: [], peak: undefined as number | undefined }
    const lo = Math.min(nz[0], 8), hi = Math.max(nz[nz.length - 1], 20)
    const points = Array.from({ length: hi - lo + 1 }, (_, i) => ({ label: hourLabel(lo + i), value: bills[lo + i] }))
    const peakVal = Math.max(...points.map((p) => p.value))
    return { points, peak: points.findIndex((p) => p.value === peakVal) }
  }, [d])

  const spark = useMemo(() => (d?.last7 ?? []).map((x) => x.sales), [d])
  const sparkBills = useMemo(() => (d?.last7 ?? []).map((x) => x.bills), [d])
  const base = d?.yesterdaySoFar ?? d?.yesterday

  const quick = [
    { label: 'New bill', to: '/pos', ok: can('pos.sell'), primary: true },
    { label: 'Add product', to: '/products', ok: can('catalog.edit') },
    { label: 'Receive stock', to: '/inventory', ok: can('purchases.edit') || can('inventory.adjust') },
    { label: "Today's report", to: '/reports', ok: can('reports.view') }
  ].filter((q) => q.ok)

  return (
    <div className="page">
      <div className="dash">
        <PageHeader
          title="Dashboard"
          subtitle={d ? `Hello ${session?.name ?? ''} · updated ${relativeTime(d.generatedAt)} · refreshes every minute` : 'Today at a glance'}
          actions={<>
            {quick.map((q) => <Button key={q.to} size="lg" variant={q.primary ? 'primary' : 'default'} onClick={() => navigate(q.to)}>{q.label}</Button>)}
            <Button size="lg" variant="ghost" onClick={reload} aria-label="Refresh dashboard" title="Refresh">⟳</Button>
          </>}
        />

        {error && !d && <ErrorState message={error} onRetry={reload} />}
        {error && d && <InlineAlert tone="warn" title="Could not refresh">{error} Showing the last loaded figures.</InlineAlert>}

        {d?.restricted && <InlineAlert tone="info" title="Limited view">You see your own sales for today and operational counters. Ask a manager for report access to see shop-wide figures.</InlineAlert>}

        {(d || first) && (
          <div className="alert-row" aria-label="Alerts">
            {d && d.lowStockCount > 0 && can('inventory.view') && (
              <InlineAlert tone="warn" title={`${formatNumber(d.lowStockCount)} item${d.lowStockCount === 1 ? '' : 's'} low on stock`} action={<Link to="/inventory">Review</Link>} />
            )}
            {d && d.openShift && (
              <InlineAlert tone="info" title={`Shift open · ${d.openShift.posName}`} action={can('pos.shift') ? <Link to="/pos">Open POS</Link> : undefined}>
                {d.openShift.userName} since {formatDateTime(d.openShift.openedAt)} · {formatNumber(d.openShift.bills)} bills · cash {formatMoney(d.openShift.openingCash + d.openShift.cashSales)}
              </InlineAlert>
            )}
            {d && !d.openShift && can('pos.shift') && (
              <InlineAlert tone="warn" title="No cash shift is open" action={<Link to="/pos">Open shift</Link>}>Open a shift before billing to track cash.</InlineAlert>
            )}
            {d && d.pendingSync > 0 && (
              <InlineAlert tone="info" title={`${formatNumber(d.pendingSync)} change${d.pendingSync === 1 ? '' : 's'} waiting to sync`} action={can('sync.manage') || can('backup.manage') ? <Link to="/backup">Sync status</Link> : undefined}>Everything is saved on this PC.</InlineAlert>
            )}
          </div>
        )}

        <div className="kpi-grid">
          <StatCard label="Today's sales" icon="₹" loading={first} value={d ? formatMoney(d.today.sales) : ''} delta={d && base ? pctChange(d.today.sales, base.sales) : null} deltaLabel="vs yesterday so far" spark={spark} hint="No sales yesterday to compare" />
          <StatCard label="Bills" icon="🧾" loading={first} value={d ? formatNumber(d.today.bills) : ''} delta={d && base ? pctChange(d.today.bills, base.bills) : null} deltaLabel="vs yesterday so far" spark={sparkBills} />
          <StatCard label="Average bill" icon="◔" loading={first} value={d ? formatMoney(d.today.avgBill) : ''} delta={d && base ? pctChange(d.today.avgBill, base.avgBill) : null} deltaLabel="vs yesterday so far" hint={d && d.today.returns ? `Returns ${formatMoney(d.today.returns)}` : undefined} />
          {showProfit
            ? <StatCard label="Gross profit" icon="▲" tone="good" loading={first} value={d ? formatMoney(d.today.grossProfit) : ''} delta={d && base?.grossProfit != null ? pctChange(d.today.grossProfit ?? 0, base.grossProfit) : null} deltaLabel="vs yesterday so far" />
            : <StatCard label="Returns today" icon="↩" loading={first} value={d ? formatMoney(d.today.returns) : ''} goodWhen="down" hint="Refunds issued today" />}
        </div>

        <div className="dash-grid">
          <Card className="span-8" title="Sales trend" actions={<Tabs label="Range" value={range} onChange={(v) => setRange(v as '7' | '30')} items={[{ key: '7', label: '7 days' }, { key: '30', label: '30 days' }]} />}>
            {first ? <Skeleton h={220} radius={8} /> : trend.length ? <TrendChart data={trend} format={formatMoneyCompact} ariaLabel={`Net sales, last ${range} days`} height={230} minMax={100000} /> : <EmptyState title="No sales yet" hint="The chart fills in as bills are saved." />}
          </Card>

          <Card className="span-4" title="Payment mix" actions={<span className="muted">30 days</span>}>
            {first ? <Skeleton lines={4} h={16} /> : <HBarList colors showShare items={(d?.paymentMix ?? []).map((p) => ({ label: cap(p.method), value: p.amount }))} format={formatMoneyCompact} empty="No payments recorded yet" />}
          </Card>

          <Card className="span-6" title="Top products" actions={<span className="muted">30 days, by revenue</span>}>
            {first ? <Skeleton lines={5} h={16} /> : <HBarList items={(d?.topProducts ?? []).slice(0, 6).map((p) => ({ label: p.name, value: p.revenue, sub: `${formatNumber(p.qty)} sold` }))} format={formatMoneyCompact} empty="Top sellers appear after your first sales" />}
          </Card>

          <Card className="span-6" title="Category share" actions={<span className="muted">30 days</span>}>
            {first ? <Skeleton lines={5} h={16} /> : <HBarList colors showShare items={(d?.categoryShare ?? []).slice(0, 6).map((c) => ({ label: c.name, value: c.revenue }))} format={formatMoneyCompact} empty="No category sales yet" />}
          </Card>

          <Card className="span-8" title="Busiest hours" actions={<span className="muted">bills by hour, last 30 days</span>}>
            {first ? <Skeleton h={170} radius={8} /> : hourly.points.length ? <BarChart data={hourly.points} height={180} highlight={hourly.peak} ariaLabel="Bills by hour of day" format={(n) => `${formatNumber(n)} bills`} /> : <EmptyState title="No data yet" />}
          </Card>

          <Card className="span-4" title="Recent sales" actions={can('reports.view') ? <Link to="/reports">All reports</Link> : undefined}>
            {first ? <Skeleton lines={5} h={18} /> : d && d.recentSales.length ? (
              <ul className="recent-list" aria-label="Recent sales">
                {d.recentSales.slice(0, 7).map((s) => (
                  <li className="recent-row" key={s.id} data-testid="recent-sale">
                    <Link className="recent-open" to={`/pos/history?sale=${s.id}`} title="Open this bill" aria-label={`Open invoice ${s.invoiceNo}, ${formatMoney(s.total)}, ${s.customerName || 'walk-in customer'}`}>
                      <span><strong>{s.invoiceNo}</strong> {s.status && s.status !== 'completed' && <Badge tone="warn">{s.status}</Badge>}<span className="muted recent-sub">{s.customerName || 'Walk-in'} · {relativeTime(s.createdAt)}</span></span>
                      <strong className="num">{formatMoney(s.total)}</strong>
                    </Link>
                    {canDelete && (
                      <Button variant="ghost" size="sm" className="del-sale-icon" title="Delete this invoice" aria-label={`Delete invoice ${s.invoiceNo}`} onClick={() => setDeleting(s)}>
                        <TrashIcon />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No sales yet" hint="Completed bills will show here." />}
          </Card>
        </div>
      </div>
      {deleting && <DeleteSaleDialog sale={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); reload() }} />}
    </div>
  )
}

export default Dashboard
