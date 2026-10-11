import { Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { call } from '@/lib/api'
import { allModules, findModuleProblems, type NavItem } from '@/lib/module'
import { useSession } from '@/lib/session'
import { Dropdown, Kbd, Spinner, formatDateTime, hasUnsavedChanges, useConfirm, useHotkeys, useLocalStorage, useTheme, Tooltip } from '@/ui'
import SetupWizard from '@/modules/setup/SetupWizard'
import LoginPage from '@/modules/auth/LoginPage'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { useShopIdentity, useSyncStatus } from './status'

const GROUPS: NonNullable<NavItem['group']>[] = ['Sell', 'Stock', 'Insights', 'Admin']

// Agent 7's idle-lock component is optional: discovered at build time, never a hard import.
const idleMods = import.meta.glob('../modules/auth/idle.{ts,tsx}', { eager: true }) as Record<string, { IdleGuard?: ComponentType; default?: ComponentType }>
const IdleGuard: ComponentType | undefined = Object.values(idleMods).map((m) => m.IdleGuard ?? m.default).find(Boolean)

const THEME_LABEL = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' } as const
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' } as const

/** App frame: first-run setup -> login -> sidebar + routes contributed by modules. */
export function Shell() {
  const { session, setupDone, refresh } = useSession()
  if (setupDone === null) return <div className="splash"><Spinner label="Starting…" /></div>
  if (!setupDone) return <ErrorBoundary scope="app"><SetupWizard onDone={refresh} /></ErrorBoundary>
  if (!session) return <ErrorBoundary scope="app"><LoginPage onDone={refresh} /></ErrorBoundary>
  return <ErrorBoundary scope="app"><AppFrame /></ErrorBoundary>
}

function AppFrame() {
  const { session, can, refresh } = useSession()
  const navigate = useNavigate()
  const loc = useLocation()
  const confirm = useConfirm()
  const [theme, , cycleTheme] = useTheme()
  const [collapsed, setCollapsed] = useLocalStorage('velmayil.sidebar.collapsed', false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const shop = useShopIdentity()
  const sync = useSyncStatus()

  const mods = useMemo(() => allModules(), [])
  useEffect(() => {
    const problems = findModuleProblems(mods)
    // eslint-disable-next-line no-console
    if (problems.length) console.error('[shell] module registry problems:\n' + problems.join('\n'))
  }, [mods])

  // Window title follows the shop name.
  useEffect(() => { document.title = shop.name }, [shop.name])

  const nav = useMemo(() => {
    const seen = new Set<string>()
    return mods.flatMap((m) => m.nav ?? [])
      .filter((n) => (!n.permission || can(n.permission)) && !seen.has(n.path) && !!seen.add(n.path))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
  }, [mods, can])
  const grouped = useMemo(() => GROUPS.map((g) => ({ g, items: nav.filter((n) => (n.group ?? 'Admin') === g) })).filter((x) => x.items.length), [nav])
  const flat = useMemo(() => grouped.flatMap((x) => x.items), [grouped])

  const routes = useMemo(() => {
    const seen = new Set<string>()
    return mods.flatMap((m) => m.routes).filter((r) => !seen.has(r.path) && !!seen.add(r.path))
  }, [mods])

  // Longest matching nav path is the active one (so /settings and /settings/shop do not both light up).
  const activePath = useMemo(() => {
    const here = loc.pathname
    return flat.filter((n) => here === n.path || here.startsWith(n.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]?.path
  }, [flat, loc.pathname])

  const go = useCallback(async (path: string) => {
    if (path === loc.pathname) return
    if (hasUnsavedChanges() && !(await confirm({ title: 'Leave this screen?', message: 'You have unsaved changes that will be lost.', confirmLabel: 'Leave', cancelLabel: 'Stay', tone: 'danger' }))) return
    navigate(path)
  }, [confirm, navigate, loc.pathname])

  const signOut = useCallback(async () => {
    if (hasUnsavedChanges() && !(await confirm({ title: 'Sign out?', message: 'You have unsaved changes that will be lost.', confirmLabel: 'Sign out', tone: 'danger' }))) return
    try { await call('auth', 'logout') } finally { await refresh() }
  }, [confirm, refresh])

  const hot: Record<string, () => void> = { 'ctrl+k': () => setPaletteOpen((o) => !o), 'ctrl+b': () => setCollapsed(!collapsed) }
  flat.slice(0, 9).forEach((n, i) => { hot[`alt+${i + 1}`] = () => { void go(n.path) } })
  useHotkeys(hot, { allowInInputs: true })

  const items: PaletteItem[] = useMemo(() => [
    ...flat.map((n, i): PaletteItem => ({ id: `nav-${n.path}`, label: n.label, group: n.group ?? 'Admin', icon: n.icon, keywords: n.path, hint: i < 9 ? `Alt+${i + 1}` : undefined, run: () => { void go(n.path) } })),
    { id: 'act-theme', label: 'Change theme (auto / light / dark)', group: 'Action', icon: '◐', run: cycleTheme },
    { id: 'act-sidebar', label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', group: 'Action', icon: '↔', hint: 'Ctrl+B', run: () => setCollapsed(!collapsed) },
    { id: 'act-signout', label: 'Sign out', group: 'Action', icon: '⎋', run: () => { void signOut() } }
  ], [flat, go, cycleTheme, collapsed, setCollapsed, signOut])

  if (!session) return null
  const initials = session.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'
  // Sync never set up (one PC): nothing waits anywhere, so no red "Offline" / "N pending sync" alarm; data is on this PC.
  const syncTone = !sync.enabled ? 'good' : !sync.online ? 'bad' : sync.error ? 'warn' : sync.pending > 0 ? 'warn' : 'good'
  const syncText = !sync.enabled ? 'Saved on this PC' : !sync.online ? 'Offline' : sync.pending > 0 ? `${sync.pending} pending sync` : 'Synced'
  const syncTip = !sync.enabled ? 'All bills and stock are stored on this computer. Multi-POS sync is off.'
    : sync.lastSyncAt ? `Last sync ${formatDateTime(sync.lastSyncAt)}` : sync.online ? 'Working offline-first; data is stored on this PC' : 'No network: sales continue and sync later'

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">{shop.logo ? <img src={shop.logo} alt="" /> : shop.name.slice(0, 1).toUpperCase()}</span>
          <span className="brand-name">{shop.name}</span>
        </div>
        {grouped.map(({ g, items: its }) => (
          <div key={g} role="group" aria-label={g}>
            <div className="group">{g}</div>
            {its.map((n) => {
              const i = flat.indexOf(n)
              return (
                <Link key={n.path} to={n.path} className={`nav ${n.path === activePath ? 'active' : ''}`} aria-current={n.path === activePath ? 'page' : undefined} title={collapsed ? n.label : undefined}
                  onClick={(e) => { if (hasUnsavedChanges()) { e.preventDefault(); void go(n.path) } }}>
                  <span className="nav-icon" aria-hidden="true">{n.icon ?? '•'}</span>
                  <span className="nav-label">{n.label}</span>
                  {i < 9 && <span className="nav-key" aria-hidden="true">Alt+{i + 1}</span>}
                </Link>
              )
            })}
          </div>
        ))}
        <div className="sidebar-foot">
          <button className="side-btn" onClick={() => setPaletteOpen(true)} aria-label="Open command palette"><span className="nav-icon" aria-hidden="true">⌕</span><span className="t">Quick jump <Kbd>Ctrl+K</Kbd></span></button>
          <button className="side-btn" onClick={() => setCollapsed(!collapsed)} aria-pressed={collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><span className="nav-icon" aria-hidden="true">{collapsed ? '»' : '«'}</span><span className="t">Collapse</span></button>
        </div>
      </nav>

      <header className="topbar">
        <span className="shop" title={shop.name}>{shop.name}</span>
        <span className="spacer" />
        <Tooltip text={syncTip} side="bottom">
          <span className={`pill pill-${syncTone}`} role="status"><i />{syncText}</span>
        </Tooltip>
        <span className="pill" title="This terminal">{session.posCode}</span>
        <button className="btn btn-ghost btn-sm" onClick={cycleTheme} aria-label={THEME_LABEL[theme]} title={THEME_LABEL[theme]}>{THEME_ICON[theme]}</button>
        <Dropdown align="right" variant="ghost" ariaLabel="Account menu"
          label={<span className="user-chip"><span className="avatar" aria-hidden="true">{initials}</span><span><strong>{session.name}</strong><small>{session.role}</small></span></span>}
          items={[
            { key: 'p', label: 'Quick jump', hint: 'Ctrl+K', icon: '⌕', onSelect: () => setPaletteOpen(true) },
            { key: 't', label: THEME_LABEL[theme], icon: THEME_ICON[theme], onSelect: cycleTheme },
            { key: 'd', label: '', divider: true },
            { key: 'o', label: 'Sign out', icon: '⎋', danger: true, onSelect: () => { void signOut() } }
          ]} />
      </header>

      <main className="main" id="main-content" tabIndex={-1}>
        <ErrorBoundary resetKey={loc.pathname}>
          <Suspense fallback={<Spinner />}>
            <Routes>
              {routes.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={items} />
      {IdleGuard && <IdleGuard />}
    </div>
  )
}
