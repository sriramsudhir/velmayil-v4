import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap, Kbd } from '@/ui'

export interface PaletteItem { id: string; label: string; group: string; icon?: ReactNode; keywords?: string; hint?: string; run: () => void }

const score = (q: string, it: PaletteItem): number => {
  const hay = `${it.label} ${it.group} ${it.keywords ?? ''}`.toLowerCase()
  if (!q) return 1
  const label = it.label.toLowerCase()
  if (label.startsWith(q)) return 4
  if (label.includes(q)) return 3
  if (hay.includes(q)) return 2
  // subsequence match (e.g. "inv" -> "Inventory")
  let i = 0
  for (const ch of label) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

/** Ctrl+K quick-jump: type to filter pages/actions, Up/Down to choose, Enter to run, Esc to close. */
export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: PaletteItem[] }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  useFocusTrap(box, open)
  useEffect(() => { if (open) { setQ(''); setIdx(0) } }, [open])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return items.map((it) => [it, score(s, it)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it)
  }, [q, items])
  useEffect(() => { setIdx(0) }, [q])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [idx])
  if (!open) return null
  const run = (it?: PaletteItem) => { if (!it) return; onClose(); it.run() }
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" ref={box} role="dialog" aria-modal="true" aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(shown.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); run(shown[idx]) }
        }}>
        <input autoFocus data-autofocus placeholder="Go to page or run action…" value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[idx] ? `pal-${shown[idx].id}` : undefined} aria-label="Search pages and actions" />
        <ul id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <li style={{ cursor: 'default' }} className="muted">No matches</li>}
          {shown.map((it, i) => (
            <li key={it.id} id={`pal-${it.id}`} role="option" aria-selected={i === idx} onMouseMove={() => setIdx(i)} onClick={() => run(it)}>
              <span aria-hidden="true">{it.icon}</span><span>{it.label}</span>
              {it.hint && <Kbd>{it.hint}</Kbd>}<span className="grp">{it.group}</span>
            </li>
          ))}
        </ul>
        <div className="palette-foot"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span><span><Kbd>Enter</Kbd> open</span><span><Kbd>Esc</Kbd> close</span></div>
      </div>
    </div>
  )
}
