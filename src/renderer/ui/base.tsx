import { Children, type ComponentPropsWithRef, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode, } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './hooks'

// ---- Shared design-system primitives (owned by the UI/UX agent; keep these exports/props stable) ----

export type Size = 'sm' | 'md' | 'lg'

export function Button({ variant = 'default', size = 'md', loading, className = '', children, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: Size; loading?: boolean }) {
  return (
    <button {...p} disabled={disabled || loading} aria-busy={loading || undefined} className={`btn btn-${variant} ${size !== 'md' ? `btn-${size}` : ''} ${className}`}>
      {loading && <span className="btn-spin" aria-hidden="true" />}
      {children}
    </button>
  )
}

// ---- Field: label <-> control association (htmlFor/id) without changing props ----
interface FieldCtxValue { register: (id: string) => void; describedBy?: string; invalid: boolean }
const FieldCtx = createContext<FieldCtxValue | null>(null)

/** Used by every form control: returns the id + aria props wired to the surrounding <Field>. */
export function useFieldControl(idProp?: string): { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true } {
  const auto = useId()
  const ctx = useContext(FieldCtx)
  const id = idProp ?? auto
  const register = ctx?.register
  useEffect(() => { register?.(id) }, [register, id])
  return { id, 'aria-describedby': ctx?.describedBy, 'aria-invalid': ctx?.invalid ? true : undefined }
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  const [ctrlId, setCtrlId] = useState<string>()
  const uid = useId()
  const register = useCallback((id: string) => setCtrlId((cur) => cur ?? id), [])
  const msgId = error || hint ? `${uid}-msg` : undefined
  // A bare DOM control (<input/>, <select/>, <textarea/>) as the only child gets an id directly.
  let content = children
  const only = Children.count(children) === 1 ? (children as ReactElement<{ id?: string }>) : null
  if (only && isValidElement(only) && typeof only.type === 'string' && /^(input|select|textarea)$/.test(only.type) && !only.props.id) {
    content = cloneElement(only, { id: `${uid}-c` })
  }
  const labelFor = ctrlId ?? (content !== children ? `${uid}-c` : undefined)
  return (
    <FieldCtx.Provider value={{ register, describedBy: msgId, invalid: !!error }}>
      <div className="field">
        <label className="field-label" htmlFor={labelFor}>{label}</label>
        {content}
        {hint && !error && <span className="field-hint" id={msgId}>{hint}</span>}
        {error && <span className="field-error" id={msgId} role="alert">{error}</span>}
      </div>
    </FieldCtx.Provider>
  )
}

type ControlSize = Size | number
const sizeCls = (s?: ControlSize) => (typeof s === 'string' && s !== 'md' ? `input-${s}` : '')
const nativeSize = (s?: ControlSize) => (typeof s === 'number' ? s : undefined)

export function Input({ size, className = '', ...p }: Omit<ComponentPropsWithRef<'input'>, 'size'> & { size?: ControlSize }) {
  const f = useFieldControl(p.id)
  return <input {...f} {...p} id={f.id} size={nativeSize(size)} className={`input ${sizeCls(size)} ${className}`} aria-describedby={p['aria-describedby'] ?? f['aria-describedby']} aria-invalid={p['aria-invalid'] ?? f['aria-invalid']} />
}
export function TextArea({ className = '', ...p }: ComponentPropsWithRef<'textarea'>) {
  const f = useFieldControl(p.id)
  return <textarea {...p} id={f.id} className={`input ${className}`} aria-describedby={p['aria-describedby'] ?? f['aria-describedby']} aria-invalid={p['aria-invalid'] ?? f['aria-invalid']} />
}
export function Select({ size, className = '', ...p }: Omit<ComponentPropsWithRef<'select'>, 'size'> & { size?: ControlSize }) {
  const f = useFieldControl(p.id)
  return <select {...p} id={f.id} size={nativeSize(size)} className={`input ${sizeCls(size)} ${className}`} aria-describedby={p['aria-describedby'] ?? f['aria-describedby']} aria-invalid={p['aria-invalid'] ?? f['aria-invalid']} />
}

export const Card = ({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-head"><h3>{title}</h3><div className="row">{actions}</div></header>}
    {children}
  </section>
)

export const PageHeader = ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) => (
  <div className="page-head">
    <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
    <div className="row">{actions}</div>
  </div>
)

export const Badge = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
)
export const Spinner = ({ label = 'Loading…' }: { label?: string }) => <div className="spinner" role="status"><span className="spin" aria-hidden="true" />{label}</div>
export const EmptyState = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="empty"><strong>{title}</strong>{hint && <p className="muted">{hint}</p>}{action}</div>
)
export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="error-state" role="alert"><strong>Something went wrong</strong><p>{message}</p>{onRetry && <Button onClick={onRetry}>Retry</Button>}</div>
)

// ---- Modal (focus trap, topmost-only Esc, scroll lock, focus restore) ----
const modalStack: symbol[] = []

export function Modal({ title, open, onClose, children, footer, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) return
    const me = Symbol('modal')
    modalStack.push(me)
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === me) { e.stopPropagation(); onCloseRef.current() }
    }
    window.addEventListener('keydown', h)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // the dialog is portaled to <body>, so everything in #root is background: make it inert + hidden from assistive tech
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    root?.setAttribute('aria-hidden', 'true')
    return () => {
      window.removeEventListener('keydown', h)
      const i = modalStack.indexOf(me)
      if (i >= 0) modalStack.splice(i, 1)
      document.body.style.overflow = prevOverflow
      if (modalStack.length === 0) {
        root?.removeAttribute('inert')
        root?.removeAttribute('aria-hidden')
      }
    }
  }, [open])
  useFocusTrap(ref, open)
  if (!open) return null
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header><h3 id={titleId}>{title}</h3><button className="btn btn-ghost" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

// ---- basic Table (kept as-is; see DataTable for sorting / keyboard / pagination) ----
export interface Column<T> { key: string; header: string; render?: (row: T) => ReactNode; align?: 'left' | 'right' | 'center'; width?: string }
export function Table<T>({ columns, rows, rowKey, onRowClick, empty }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string | number; onRowClick?: (r: T) => void; empty?: ReactNode }) {
  // Progressive rendering: a 500-row list used to mount ~4,500 DOM nodes at once (150+ ms long task on every refresh).
  // The first TABLE_CHUNK rows paint immediately; the rest are one click away. Small tables are unaffected.
  const [shown, setShown] = useState(TABLE_CHUNK)
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  const view = rows.length > shown ? rows.slice(0, shown) : rows
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" style={{ textAlign: c.align, width: c.width }}>{c.header}</th>)}</tr></thead>
        <tbody>
          {view.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'clickable' : ''}>
              {columns.map((c) => <td key={c.key} style={{ textAlign: c.align }}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <div className="row" style={{ justifyContent: 'center', padding: 8, gap: 8 }}>
          <span className="muted">Showing {shown} of {rows.length}</span>
          <button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + TABLE_CHUNK * 2)}>Show more</button>
        </div>
      )}
    </div>
  )
}
const TABLE_CHUNK = 100

/** Load async data with loading/error state. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e instanceof Error ? e.message : String(e))).finally(() => live && setLoading(false))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, loading, error, reload: () => setTick((t) => t + 1) }
}
