import { useState } from 'react'
import { PageHeader, Tabs } from '@/ui'
import { TemplatesTab } from './TemplatesTab'
import { PrintersTab } from './PrintersTab'
import { TestPrintTab } from './TestPrintTab'
import { LabelsTab } from './LabelsTab'
import { PrintLogTab } from './PrintLogTab'

const TABS = [
  { key: 'templates', label: 'Templates' },
  { key: 'printers', label: 'Printers' },
  { key: 'test', label: 'Test print' },
  { key: 'labels', label: 'Labels' },
  { key: 'log', label: 'Print log' }
]

export function PrintingPage() {
  const [tab, setTab] = useState('templates')
  return (
    <div className="page">
      <PageHeader title="Printing & Labels" subtitle="Receipt, invoice and label layouts, printers and test pages" />
      <Tabs items={TABS} value={tab} onChange={setTab} label="Printing sections" />
      <div style={{ marginTop: 16 }}>
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'printers' && <PrintersTab />}
        {tab === 'test' && <TestPrintTab />}
        {tab === 'labels' && <LabelsTab />}
        {tab === 'log' && <PrintLogTab />}
      </div>
    </div>
  )
}
