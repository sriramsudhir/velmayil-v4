import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { SessionProvider } from './lib/session'
import { ConfirmProvider, ToastProvider, applyTheme } from './ui'
import { Shell } from './shell/Shell'

applyTheme() // apply saved light/dark choice before first paint

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </HashRouter>
  </StrictMode>
)
