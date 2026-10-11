import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from './base'
import { useFocusTrap } from './hooks'

// ---- Drawer ----
export function Drawer({ open, onClose, title, children, footer, side = 'right', width = 420 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; side?: 'left' | 'right'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useFocusTrap(ref, open)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside ref={ref} className={`drawer drawer-${side}`} style={{ width }} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <header><h3 id={id}>{title}</h3><button className="btn btn-ghost" aria-label="Close" onClick={onClose}>✕</button></header>
        <div className="drawer-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </aside>
    </div>
  )
}

// ---- Confirm ----
export interface ConfirmOptions { title?: string; message: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger' }

export function ConfirmDialog({ open, title = 'Please confirm', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }:
  ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} open={open} onClose={onCancel}
      footer={<><Button onClick={onCancel}>{cancelLabel}</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} data-autofocus onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm() } }}>{message}</div>
    </Modal>
  )
}

type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>
const ConfirmCtx = createContext<ConfirmFn>(async (o) => window.confirm(typeof o === 'string' ? o : String(o.message)))

/** const confirm = useConfirm();  if (await confirm({ message: 'Delete?', tone: 'danger' })) ... */
export const useConfirm = (): ConfirmFn => useContext(ConfirmCtx)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)
  const confirm = useCallback<ConfirmFn>((o) => new Promise<boolean>((resolve) => setState({ opts: typeof o === 'string' ? { message: o } : o, resolve })), [])
  const done = (v: boolean) => { state?.resolve(v); setState(null) }
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && <ConfirmDialog open {...state.opts} onConfirm={() => done(true)} onCancel={() => done(false)} />}
    </ConfirmCtx.Provider>
  )
}

// ---- Tooltip ----
export function Tooltip({ text, children, side = 'top' }: { text: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  const id = useId()
  return (
    <span className="tip" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className={`tip-bubble tip-${side}`}>{text}</span>
    </span>
  )
}

// ---- Dropdown / Menu ----
export interface MenuItem { key: string; label: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean; divider?: boolean; hint?: string }

export function Dropdown({ label, items, align = 'left', variant = 'default', size = 'md', ariaLabel }: { label: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; variant?: 'default' | 'primary' | 'ghost'; size?: 'sm' | 'md' | 'lg'; ariaLabel?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', down)
    menu.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus()
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLElement>('button')?.focus(); e.stopPropagation() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  return (
    <div className="dropdown" ref={root} onKeyDown={open ? onKey : undefined}>
      <Button variant={variant} size={size} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }}>
        {label} <span aria-hidden="true" className="caret">▾</span>
      </Button>
      {open && (
        <div className={`menu menu-${align}`} role="menu" id={id} ref={menu}>
          {items.map((it) => it.divider
            ? <hr key={it.key} className="menu-sep" />
            : <button key={it.key} type="button" role="menuitem" disabled={it.disabled} className={`menu-item ${it.danger ? 'danger' : ''}`} onClick={() => { setOpen(false); it.onSelect?.() }}>
                {it.icon && <span className="menu-icon" aria-hidden="true">{it.icon}</span>}<span>{it.label}</span>{it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>)}
        </div>
      )}
    </div>
  )
}
/** Alias: a Menu is a Dropdown. */
export const Menu = Dropdown
