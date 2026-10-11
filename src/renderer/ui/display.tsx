import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Sparkline } from './charts'

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>
/** <KeyHint keys="Ctrl+K" /> renders [Ctrl] [K]. */
export const KeyHint = ({ keys, label }: { keys: string; label?: string }) => (
  <span className="keyhint" aria-label={label ? `${label} (${keys})` : keys}>
    {keys.split('+').map((k, i) => <Kbd key={i}>{k.trim()}</Kbd>)}{label && <span className="keyhint-label">{label}</span>}
  </span>
)

export const Toolbar = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`toolbar ${className}`} role="toolbar">{children}</div>
export const ToolbarSpacer = () => <span className="toolbar-spacer" />

export const FormGrid = ({ cols = 2, children }: { cols?: 1 | 2 | 3 | 4; children: ReactNode }) => (
  <div className="form-grid" style={{ '--cols': cols } as CSSProperties}>{children}</div>
)

export function InlineAlert({ tone = 'info', title, children, action }: { tone?: 'info' | 'good' | 'warn' | 'bad'; title?: string; children?: ReactNode; action?: ReactNode }) {
  const icon = { info: 'ℹ', good: '✓', warn: '!', bad: '✕' }[tone]
  return (
    <div className={`alert alert-${tone}`} role={tone === 'bad' || tone === 'warn' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden="true">{icon}</span>
      <div className="alert-body">{title && <strong>{title}</strong>}{children && <div>{children}</div>}</div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  )
}

export function ProgressBar({ value, max = 100, tone = 'primary', label, showValue }: { value: number; max?: number; tone?: 'primary' | 'good' | 'warn' | 'bad'; label?: string; showValue?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="progress-wrap">
      <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`progress-bar progress-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {showValue && <span className="progress-val">{Math.round(pct)}%</span>}
    </div>
  )
}

/** Loading placeholder. <Skeleton h={20} w="60%" /> or <Skeleton lines={3} />. */
export function Skeleton({ w = '100%', h = 14, lines, radius }: { w?: number | string; h?: number | string; lines?: number; radius?: number }) {
  if (lines) {
    return (
      <div className="skeleton-lines" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton" style={{ height: h, width: i === lines - 1 && lines > 1 ? '60%' : w, borderRadius: radius }} />)}
      </div>
    )
  }
  return <span className="skeleton" aria-hidden="true" style={{ width: w, height: h, borderRadius: radius }} />
}
export const SkeletonTable = ({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) => (
  <div className="table-wrap" role="status" aria-label="Loading">
    <table className="table"><tbody>
      {Array.from({ length: rows }, (_, r) => <tr key={r}>{Array.from({ length: cols }, (_, c) => <td key={c}><Skeleton h={12} w={c === 0 ? '70%' : '50%'} /></td>)}</tr>)}
    </tbody></table>
  </div>
)

export interface TabItem { key: string; label: ReactNode; badge?: ReactNode; disabled?: boolean }
/** Accessible tab strip (arrow keys, Home/End). Render the active panel yourself: {tab === 'a' && ...}. */
export function Tabs({ items, value, onChange, label = 'Sections' }: { items: TabItem[]; value: string; onChange: (key: string) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent) => {
    const enabled = items.filter((i) => !i.disabled)
    const idx = enabled.findIndex((i) => i.key === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(enabled[next].key)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={onKey}>
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={t.key === value} tabIndex={t.key === value ? 0 : -1} disabled={t.disabled} className={`tab ${t.key === value ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}{t.badge != null && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

/** KPI tile. delta = percent vs previous period (null/undefined = hidden). goodWhen: which direction is good. */
export function StatCard({ label, value, hint, delta, goodWhen = 'up', icon, tone = 'neutral', spark, to, loading, deltaLabel = 'vs yesterday' }:
  { label: string; value: ReactNode; hint?: ReactNode; delta?: number | null; goodWhen?: 'up' | 'down'; icon?: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad'; spark?: number[]; to?: string; loading?: boolean; deltaLabel?: string }) {
  const up = (delta ?? 0) >= 0
  const good = delta == null || Math.abs(delta) < 0.05 ? null : up === (goodWhen === 'up')
  const body = (
    <>
      <div className="stat-top"><span className="stat-label">{label}</span>{icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}</div>
      {loading ? <Skeleton h={28} w="60%" /> : <div className="stat-value num">{value}</div>}
      <div className="stat-foot">
        {!loading && delta != null && (
          <span className={`delta ${good === null ? '' : good ? 'delta-good' : 'delta-bad'}`}>
            <span aria-hidden="true">{up ? '▲' : '▼'}</span> {Math.abs(delta).toFixed(Math.abs(delta) >= 100 ? 0 : 1)}% <span className="muted">{deltaLabel}</span>
          </span>
        )}
        {!loading && delta == null && hint && <span className="muted">{hint}</span>}
        {!loading && spark && spark.length > 1 && <span className="stat-spark"><Sparkline data={spark} width={84} height={28} /></span>}
      </div>
    </>
  )
  const cls = `stat stat-${tone} ${to ? 'stat-link' : ''}`
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>
}
