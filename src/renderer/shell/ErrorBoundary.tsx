import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; /** change to reset the boundary (e.g. the route) */ resetKey?: unknown; scope?: 'app' | 'page' }
interface State { error: Error | null }

/** Catches render errors so one broken screen never blanks the whole POS. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ui] render error', error, info.componentStack)
  }
  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const app = this.props.scope === 'app'
    return (
      <div className="crash" role="alert">
        <div className="crash-box">
          <h2>This screen hit a problem</h2>
          <p className="muted">Your saved data is safe. Nothing was lost on the server side; any unsaved edits on this screen may need to be re-entered.</p>
          <pre>{error.message || String(error)}</pre>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
            {!app && <a className="btn" href="#/dashboard" onClick={() => this.setState({ error: null })}>Go to dashboard</a>}
            <button className="btn" onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </div>
      </div>
    )
  }
}
