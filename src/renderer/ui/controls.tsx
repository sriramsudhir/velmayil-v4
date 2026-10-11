import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { useFieldControl, type Size } from './base'
import { paiseToRupeeString, parseRupeesToPaise } from './format'
import { useDebounced } from './hooks'

type Base = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size' | 'type' | 'min' | 'max' | 'step'>
const sizeCls = (s?: Size) => (s && s !== 'md' ? `input-${s}` : '')

/** Rupee entry <-> integer paise. value/onChange are PAISE (null = empty). Float math is never used. */
export function MoneyInput({ value, onChange, size, min, max, allowNegative, onEnter, className = '', onBlur, onKeyDown, placeholder = '0.00', ...p }:
  Base & { value: number | null | undefined; onChange: (paise: number | null) => void; size?: Size; min?: number; max?: number; allowNegative?: boolean; onEnter?: () => void }) {
  const f = useFieldControl(p.id)
  const [text, setText] = useState(() => paiseToRupeeString(value ?? null, { trimZero: true }))
  const focused = useRef(false)
  useEffect(() => {
    // external value changes (not caused by our own typing) refresh the text
    setText((cur) => (!focused.current || (parseRupeesToPaise(cur) ?? null) !== (value ?? null) ? paiseToRupeeString(value ?? null, { trimZero: focused.current }) : cur))
  }, [value])
  const clamp = (n: number | null) => (n == null ? n : Math.min(max ?? Infinity, Math.max(allowNegative ? (min ?? -Infinity) : (min ?? 0), n)))
  return (
    <div className={`input-affix ${sizeCls(size)} ${className}`}>
      <span className="affix" aria-hidden="true">₹</span>
      <input
        {...p}
        {...f}
        inputMode="decimal"
        autoComplete="off"
        className="input input-bare num"
        placeholder={placeholder}
        value={text}
        onFocus={(e) => { focused.current = true; e.currentTarget.select(); p.onFocus?.(e) }}
        onChange={(e) => {
          const raw = e.target.value
          const re = allowNegative ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/
          if (!re.test(raw.replace(/[₹,\s]/g, ''))) return
          setText(raw)
          onChange(raw.trim() === '' || raw === '-' || raw === '.' ? null : clamp(parseRupeesToPaise(raw)))
        }}
        onBlur={(e) => {
          focused.current = false
          const n = clamp(parseRupeesToPaise(text))
          setText(paiseToRupeeString(n))
          if (n !== (value ?? null)) onChange(n)
          onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter()
          onKeyDown?.(e)
        }}
      />
    </div>
  )
}

/** Numeric entry (quantities, percentages). value/onChange are numbers (null = empty). */
export function NumberInput({ value, onChange, size, min, max, step = 1, decimals = 0, onEnter, className = '', onBlur, onKeyDown, suffix, ...p }:
  Base & { value: number | null | undefined; onChange: (n: number | null) => void; size?: Size; min?: number; max?: number; step?: number; decimals?: number; onEnter?: () => void; suffix?: ReactNode }) {
  const f = useFieldControl(p.id)
  const [text, setText] = useState(value == null ? '' : String(value))
  const focused = useRef(false)
  useEffect(() => {
    setText((cur) => (!focused.current || (cur === '' || cur === '-' || cur === '.' ? null : Number(cur)) !== (value ?? null) ? (value == null ? '' : String(value)) : cur))
  }, [value])
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const re = new RegExp(`^${(min ?? -1) < 0 ? '-?' : ''}\\d*${decimals > 0 ? `\\.?\\d{0,${decimals}}` : ''}$`)
  const commit = (n: number | null) => { if (n !== (value ?? null)) onChange(n) }
  return (
    <div className={`input-affix ${sizeCls(size)} ${className}`}>
      <input
        {...p}
        {...f}
        inputMode={decimals ? 'decimal' : 'numeric'}
        autoComplete="off"
        className="input input-bare num"
        value={text}
        onFocus={(e) => { focused.current = true; e.currentTarget.select(); p.onFocus?.(e) }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[,\s]/g, '') // "1,000" pasted or typed with grouping is 1000, not a refused keystroke
          if (!re.test(raw)) return
          setText(raw)
          const n = Number(raw)
          if (raw === '' || raw === '-' || raw === '.' || Number.isNaN(n)) onChange(null)
          else onChange(n)
        }}
        onBlur={(e) => {
          focused.current = false
          const n = text === '' || text === '-' || text === '.' ? null : clamp(Number(text))
          setText(n == null ? '' : String(n))
          commit(n)
          onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const cur = text === '' ? 0 : Number(text)
            const n = clamp(Math.round((cur + (e.key === 'ArrowUp' ? step : -step)) * 1e6) / 1e6)
            setText(String(n)); onChange(n)
          }
          if (e.key === 'Enter' && onEnter) onEnter()
          onKeyDown?.(e)
        }}
      />
      {suffix && <span className="affix affix-end" aria-hidden="true">{suffix}</span>}
    </div>
  )
}

/** Debounced search box. onSearch fires `delay` ms after typing stops (and immediately on Enter / clear). Esc clears. */
export function SearchInput({ onSearch, delay = 250, defaultValue = '', size, placeholder = 'Search…', autoFocus, className = '', ...p }:
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'value' | 'onChange' | 'defaultValue' | 'type'> & { onSearch: (text: string) => void; delay?: number; defaultValue?: string; size?: Size }) {
  const f = useFieldControl(p.id)
  const [text, setText] = useState(defaultValue)
  const debounced = useDebounced(text, delay)
  const last = useRef(defaultValue)
  const cb = useRef(onSearch)
  cb.current = onSearch
  useEffect(() => {
    if (debounced !== last.current) { last.current = debounced; cb.current(debounced) }
  }, [debounced])
  const fire = (v: string) => { if (v !== last.current) { last.current = v; cb.current(v) } }
  return (
    <div className={`input-affix search ${sizeCls(size)} ${className}`}>
      <span className="affix" aria-hidden="true">⌕</span>
      <input
        {...p}
        {...f}
        type="search"
        role="searchbox"
        autoFocus={autoFocus}
        autoComplete="off"
        className="input input-bare"
        placeholder={placeholder}
        aria-label={p['aria-label'] ?? placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') fire(text)
          if (e.key === 'Escape' && text) { e.stopPropagation(); setText(''); fire('') }
          p.onKeyDown?.(e)
        }}
      />
      {text && <button type="button" className="affix affix-btn" aria-label="Clear search" onClick={() => { setText(''); fire('') }}>✕</button>}
    </div>
  )
}

// ---- Toggle / Checkbox / Radio ----
export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  const f = useFieldControl(id)
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" role="switch" id={f.id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-checked={checked} />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  )
}

export function Checkbox({ label, className = '', ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode }) {
  return (
    <label className={`check ${p.disabled ? 'is-disabled' : ''} ${className}`}>
      <input {...p} type="checkbox" />
      {label && <span>{label}</span>}
    </label>
  )
}

export function Radio({ label, className = '', ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode }) {
  return (
    <label className={`check ${p.disabled ? 'is-disabled' : ''} ${className}`}>
      <input {...p} type="radio" />
      {label && <span>{label}</span>}
    </label>
  )
}

export function RadioGroup<V extends string | number>({ name, value, onChange, options, inline = true, label }: { name: string; value: V; onChange: (v: V) => void; options: { value: V; label: ReactNode; disabled?: boolean }[]; inline?: boolean; label?: string }) {
  return (
    <div className={inline ? 'row radio-group' : 'radio-group col'} role="radiogroup" aria-label={label}>
      {options.map((o) => <Radio key={String(o.value)} name={name} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} label={o.label} />)}
    </div>
  )
}
