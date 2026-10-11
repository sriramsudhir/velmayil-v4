import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { SessionInfo } from '@shared/ipc'
import { hasPermission, type Permission } from '@shared/permissions'
import { call } from './api'

interface Ctx {
  session: SessionInfo | null
  setupDone: boolean | null
  refresh: () => Promise<void>
  can: (p: Permission) => boolean
}
const SessionCtx = createContext<Ctx>({ session: null, setupDone: null, refresh: async () => {}, can: () => false })
export const useSession = () => useContext(SessionCtx)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const refresh = useCallback(async () => {
    try {
      const st = await call<{ complete: boolean }>('setup', 'status')
      setSetupDone(st.complete)
      setSession(st.complete ? await call<SessionInfo | null>('auth', 'current') : null)
    } catch {
      setSetupDone(true)
      setSession(null)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const can = useCallback((p: Permission) => !!session && hasPermission(session.permissions, p), [session])
  return <SessionCtx.Provider value={{ session, setupDone, refresh, can }}>{children}</SessionCtx.Provider>
}
