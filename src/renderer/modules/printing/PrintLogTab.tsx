import { useState } from 'react'
import { call } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorState, InlineAlert, Select, Spinner, Table, Toggle, useApiAction, useAsync, formatDateTime } from '@/ui'
import type { PrinterProfile, PrintLogRow, PrintResult } from './shared'

/** Recent print attempts. Failed jobs keep their document so they can be retried, sent to another printer, or saved as PDF. */
export function PrintLogTab() {
  const { run, loading } = useApiAction()
  const [onlyFailed, setOnlyFailed] = useState(true)
  const [other, setOther] = useState<number | ''>('')
  const [last, setLast] = useState<PrintResult | null>(null)
  const log = useAsync(() => call<PrintLogRow[]>('printing', 'listPrintLog', { limit: 100, onlyFailed }), [onlyFailed])
  const profiles = useAsync(() => call<PrinterProfile[]>('printing', 'listPrinterProfiles'), [])

  const retry = async (row: PrintLogRow) => {
    const r = await run(() => call<PrintResult>('printing', 'retryPrint', { logId: row.id, ...(other ? { printerProfileId: other } : {}) }))
    if (r) { setLast(r); log.reload() }
  }

  if (log.loading && !log.data) return <Spinner />
  if (log.error) return <ErrorState message={log.error} onRetry={log.reload} />

  return (
    <Card title="Print log" actions={<div className="row"><Toggle checked={onlyFailed} onChange={setOnlyFailed} label="Failures only" /><Button size="sm" onClick={log.reload}>Refresh</Button></div>}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted">Retry on:</span>
        <Select value={other} onChange={(e) => setOther(e.target.value ? Number(e.target.value) : '')} style={{ maxWidth: 280 }}>
          <option value="">Default printer for the paper type</option>
          {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      {last && (!last.ok ? <InlineAlert tone="bad" title="Still not printing">{last.error}</InlineAlert> : last.warning ? <InlineAlert tone="warn" title="Printed on another printer">{last.warning}</InlineAlert> : <InlineAlert tone="good">Sent to the printer.</InlineAlert>)}
      <Table
        rows={log.data ?? []}
        rowKey={(r) => r.id}
        empty={<EmptyState title={onlyFailed ? 'No print failures' : 'Nothing printed yet'} hint="Failed prints appear here so nothing is lost; the sale itself is always saved." />}
        columns={[
          { key: 'ts', header: 'When', render: (r) => formatDateTime(r.ts) },
          { key: 'doc', header: 'Document', render: (r) => r.docRef || r.action },
          { key: 'paper', header: 'Paper' },
          { key: 'printer', header: 'Printer', render: (r) => r.printer || 'Windows default' },
          { key: 'status', header: 'Result', render: (r) => (r.ok ? <Badge tone="good">Printed</Badge> : <Badge tone="bad">Failed</Badge>) },
          { key: 'error', header: 'Details', render: (r) => r.error ?? '' },
          { key: 'a', header: '', align: 'right', render: (r) => (!r.ok && r.retryable ? <Button size="sm" onClick={() => void retry(r)} disabled={loading}>Retry</Button> : null) }
        ]}
      />
    </Card>
  )
}
