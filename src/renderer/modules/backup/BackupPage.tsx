import { useState } from 'react'
import { call } from '@/lib/api'
import { PageHeader, useAsync } from '@/ui'
import { BackupPanel } from './BackupPanel'
import { SyncPanel } from './SyncPanel'

function Page() {
  const [tab, setTab] = useState<'backup' | 'sync'>('backup')
  // queue badge on the tab (cheap status call; failures just hide it)
  const q = useAsync(() => call<{ pending: number; enabled: boolean }>('sync', 'getStatus').catch(() => null), [tab])
  const pending = q.data?.enabled ? q.data.pending : 0
  return (
    <div className="page">
      <PageHeader title="Backup & Sync" subtitle="Protect your data and keep several counters in step" />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'backup'} className={`tab ${tab === 'backup' ? 'active' : ''}`} onClick={() => setTab('backup')}>Backup &amp; Restore</button>
        <button role="tab" aria-selected={tab === 'sync'} className={`tab ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>
          Multi-POS Sync{pending > 0 && <span className="tab-badge" title="Changes waiting to be sent">{pending}</span>}
        </button>
      </div>
      {tab === 'backup' ? <BackupPanel /> : <SyncPanel />}
    </div>
  )
}

export default Page
