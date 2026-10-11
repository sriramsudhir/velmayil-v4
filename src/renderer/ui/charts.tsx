import { useEffect, useRef, useState, type ReactNode } from 'react'

// Small dependency-free SVG charts. Colours come from --c1..--c6 / --chart-* tokens (light + dark aware).

export const CHART_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']

function useWidth(fallback = 600): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { const n = Math.floor(el.getBoundingClientRect().width); if (n > 0) setW(n) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const niceMax = (v: number): number => {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

export function Sparkline({ data, width = 100, height = 32, color = 'var(--c1)', label }: { data: number[]; width?: number; height?: number; color?: string; label?: string }) {
  if (data.length < 2) return <svg width={width} height={height} aria-hidden="true" />
  const min = Math.min(...data), max = Math.max(...data)
  const span = max - min || 1
  const pad = 3
  const pts = data.map((v, i) => [pad + (i * (width - pad * 2)) / (data.length - 1), height - pad - ((v - min) / span) * (height - pad * 2)] as const)
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `Trend of ${data.length} points`}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  )
}

export interface Point { label: string; value: number }

/** Area/line chart with y-grid, x labels and hover read-out. */
export function TrendChart({ data, height = 220, format = (n: number) => String(n), color = 'var(--c1)', ariaLabel = 'Trend chart', xLabelEvery, minMax = 1 }:
  { minMax?: number; data: Point[]; height?: number; format?: (n: number) => string; color?: string; ariaLabel?: string; xLabelEvery?: number }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const m = { t: 12, r: 12, b: 24, l: 52 }
  const iw = Math.max(40, width - m.l - m.r), ih = height - m.t - m.b
  const max = niceMax(Math.max(minMax, ...data.map((d) => d.value)))
  const x = (i: number) => m.l + (data.length > 1 ? (i * iw) / (data.length - 1) : iw / 2)
  const y = (v: number) => m.t + ih - (v / max) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ')
  const every = xLabelEvery ?? Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64))))
  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${ariaLabel}. ${data.length} points, peak ${format(Math.max(0, ...data.map((d) => d.value)))}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const rel = e.clientX - r.left - m.l
          setHover(Math.min(data.length - 1, Math.max(0, Math.round((rel / iw) * (data.length - 1)))))
        }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="chart-text">{compactAxis(t, format)}</text>
          </g>
        ))}
        {data.length > 0 && <path d={`${path} L${x(data.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={color} opacity={0.12} />}
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (i % every === 0 || i === data.length - 1) && (i === data.length - 1 || data.length - 1 - i >= every / 2) ? <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="chart-text">{d.label}</text> : null)}
        {data.length <= 40 && data.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.value)} r={hover === i ? 4.5 : 2.5} fill={color}><title>{`${d.label}: ${format(d.value)}`}</title></circle>)}
        {hover != null && data[hover] && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} className="chart-cursor" />}
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tip" style={{ left: Math.min(width - 130, Math.max(0, x(hover) - 55)), top: 0 }}>
          <span className="muted">{data[hover].label}</span> <strong className="num">{format(data[hover].value)}</strong>
        </div>
      )}
    </div>
  )
}
const compactAxis = (v: number, format: (n: number) => string) => format(v)

/** Vertical bars (e.g. sales by hour). Highlights `highlight` index; <title> per bar for hover. */
export function BarChart({ data, height = 180, format = (n: number) => String(n), color = 'var(--c1)', ariaLabel = 'Bar chart', highlight }:
  { data: Point[]; height?: number; format?: (n: number) => string; color?: string; ariaLabel?: string; highlight?: number }) {
  const [ref, width] = useWidth()
  const m = { t: 8, r: 8, b: 22, l: 8 }
  const iw = width - m.l - m.r, ih = height - m.t - m.b
  const max = Math.max(1, ...data.map((d) => d.value))
  const slot = data.length ? iw / data.length : iw
  const bw = Math.max(2, Math.min(36, slot * 0.68))
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 34))))
  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${ariaLabel}. Peak ${format(max)}`}>
        <line x1={m.l} x2={width - m.r} y1={m.t + ih} y2={m.t + ih} className="chart-grid" />
        {data.map((d, i) => {
          const h = (d.value / max) * ih
          const cx = m.l + slot * i + slot / 2
          return (
            <g key={i}>
              <rect x={cx - bw / 2} y={m.t + ih - h} width={bw} height={Math.max(d.value > 0 ? 2 : 0, h)} rx={3} fill={color} opacity={highlight == null || highlight === i ? 1 : 0.45}><title>{`${d.label}: ${format(d.value)}`}</title></rect>
              {i % every === 0 && <text x={cx} y={height - 6} textAnchor="middle" className="chart-text">{d.label}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Ranked horizontal bars with value + share. Good for top products, categories, payment mix. */
export function HBarList({ items, format = (n: number) => String(n), showShare, colors = false, empty = 'No data yet' }:
  { items: { label: string; value: number; sub?: ReactNode }[]; format?: (n: number) => string; showShare?: boolean; colors?: boolean; empty?: string }) {
  if (!items.length) return <p className="muted center-text">{empty}</p>
  const total = items.reduce((a, b) => a + b.value, 0) || 1
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <ul className="hbars">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`}>
          <div className="hbar-top">
            <span className="hbar-label" title={it.label}>{colors && <i className="dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />}{it.label}</span>
            <span className="hbar-val num">{format(it.value)}{showShare && <span className="muted"> · {Math.round((it.value / total) * 100)}%</span>}</span>
          </div>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(it.value / max) * 100}%`, background: colors ? CHART_COLORS[i % CHART_COLORS.length] : 'var(--c1)' }} /></div>
          {it.sub && <div className="hbar-sub muted">{it.sub}</div>}
        </li>
      ))}
    </ul>
  )
}
