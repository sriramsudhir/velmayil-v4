import { useState } from 'react'
import { Badge, Button, Card, Input, Select, Table, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { Brand, Category } from './types'

export function TaxonomyTab({ categories, brands, reload }: { categories: Category[]; brands: Brand[]; reload: () => void }) {
  const toast = useToast()
  const { can } = useSession()
  const canEdit = can('catalog.edit')
  const [catName, setCatName] = useState('')
  const [catParent, setCatParent] = useState('')
  const [brandName, setBrandName] = useState('')

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok, 'good'); reload() } catch (e) { toast(errMsg(e), 'bad') }
  }
  const rename = (label: string, current: string) => prompt(`New name for ${label}`, current)?.trim() || null

  return (
    <div className="grid2" style={{ alignItems: 'start' }}>
      <Card title="Categories">
        {canEdit && (
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <Input placeholder="New category" value={catName} onChange={(e) => setCatName(e.target.value)} />
            <Select value={catParent} onChange={(e) => setCatParent(e.target.value)}>
              <option value="">Top level</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
            </Select>
            <Button variant="primary" disabled={!catName.trim()} onClick={() => void act(async () => {
              await call('catalog', 'saveCategory', { name: catName, parentId: catParent ? Number(catParent) : null })
              setCatName('')
            }, 'Category added')}>Add</Button>
          </div>
        )}
        <Table
          rows={categories} rowKey={(c) => c.id}
          columns={[
            { key: 'path', header: 'Category', render: (c) => <span style={{ opacity: c.active ? 1 : 0.5 }}>{c.path}</span> },
            { key: 'productCount', header: 'Products', align: 'right' },
            { key: 'active', header: '', render: (c) => (c.active ? null : <Badge>inactive</Badge>) },
            {
              key: 'actions', header: '', align: 'right',
              render: (c) => canEdit ? (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => { const n = rename('category', c.name); if (n) void act(() => call('catalog', 'saveCategory', { id: c.id, name: n, parentId: c.parentId, active: c.active }), 'Renamed') }}>Rename</Button>
                  <Button variant="ghost" onClick={() => void act(() => call('catalog', 'saveCategory', { id: c.id, name: c.name, parentId: c.parentId, active: !c.active }), c.active ? 'Deactivated' : 'Activated')}>{c.active ? 'Deactivate' : 'Activate'}</Button>
                  {can('catalog.delete') && <Button variant="ghost" onClick={() => { if (confirm(`Delete "${c.name}"? If it is in use it will be deactivated instead.`)) void act(() => call('catalog', 'deleteCategory', { id: c.id }), 'Done') }}>Delete</Button>}
                </span>
              ) : null
            }
          ]}
        />
      </Card>
      <Card title="Brands">
        {canEdit && (
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <Input placeholder="New brand" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
            <Button variant="primary" disabled={!brandName.trim()} onClick={() => void act(async () => { await call('catalog', 'saveBrand', { name: brandName }); setBrandName('') }, 'Brand added')}>Add</Button>
          </div>
        )}
        <Table
          rows={brands} rowKey={(b) => b.id}
          columns={[
            { key: 'name', header: 'Brand', render: (b) => <span style={{ opacity: b.active ? 1 : 0.5 }}>{b.name}</span> },
            { key: 'productCount', header: 'Products', align: 'right' },
            { key: 'active', header: '', render: (b) => (b.active ? null : <Badge>inactive</Badge>) },
            {
              key: 'actions', header: '', align: 'right',
              render: (b) => canEdit ? (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => { const n = rename('brand', b.name); if (n) void act(() => call('catalog', 'saveBrand', { id: b.id, name: n, active: b.active }), 'Renamed') }}>Rename</Button>
                  <Button variant="ghost" onClick={() => void act(() => call('catalog', 'saveBrand', { id: b.id, name: b.name, active: !b.active }), b.active ? 'Deactivated' : 'Activated')}>{b.active ? 'Deactivate' : 'Activate'}</Button>
                  {can('catalog.delete') && <Button variant="ghost" onClick={() => { if (confirm(`Delete "${b.name}"? If it is in use it will be deactivated instead.`)) void act(() => call('catalog', 'deleteBrand', { id: b.id }), 'Done') }}>Delete</Button>}
                </span>
              ) : null
            }
          ]}
        />
      </Card>
    </div>
  )
}
