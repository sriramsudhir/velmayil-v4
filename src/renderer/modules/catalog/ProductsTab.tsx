import { useEffect, useState } from 'react'
import { Badge, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, Table, useAsync, useToast, type Column } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useLiveRefresh } from '@/lib/live'
import { formatINR } from '@shared/money'
import { LabelPrintDialog } from '@/modules/printing/LabelPrintDialog'
import { ProductForm } from './ProductForm'
import { ImportWizard } from './ImportWizard'
import { BarcodeNumberingDialog } from './BarcodeNumberingDialog'
import { bpToPct, downloadBase64, type Brand, type Category, type ProductDetail, type ProductListRow } from './types'

const PAGE = 50

export function ProductsTab({ categories, brands, reloadTaxonomy }: { categories: Category[]; brands: Brand[]; reloadTaxonomy: () => void }) {
  const toast = useToast()
  const { can } = useSession()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [active, setActive] = useState('1')
  const [lowStock, setLowStock] = useState(false)
  const [noBarcode, setNoBarcode] = useState(false)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null | undefined>(undefined) // undefined = closed, null = new
  const [showImport, setShowImport] = useState(false)
  const [bulkCat, setBulkCat] = useState('')
  const [labelIds, setLabelIds] = useState<number[] | null>(null)
  const [showNumbering, setShowNumbering] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => (setQ(search), setPage(0)), 250)
    return () => clearTimeout(t)
  }, [search])

  const list = useAsync(
    () => call<{ rows: ProductListRow[]; total: number }>('catalog', 'list', {
      search: q || undefined, categoryId: categoryId ? Number(categoryId) : undefined, brandId: brandId ? Number(brandId) : undefined,
      active: active === '' ? undefined : active === '1', lowStock: lowStock || undefined, noBarcode: noBarcode || undefined,
      limit: PAGE, offset: page * PAGE
    }),
    [q, categoryId, brandId, active, lowStock, noBarcode, page]
  )
  useLiveRefresh(['catalog', 'pos', 'inventory', 'purchases'], list.reload)
  const rows = list.data?.rows ?? []
  const total = list.data?.total ?? 0
  const canEdit = can('catalog.edit')

  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const ids = [...selected]
  const refresh = () => { setSelected(new Set()); list.reload(); reloadTaxonomy() }

  const bulk = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg, 'good'); refresh() } catch (e) { toast(errMsg(e), 'bad') }
  }

  const doExport = async (format: 'csv' | 'xlsx') => {
    try {
      const r = await call<{ path?: string; cancelled?: boolean; bytesBase64?: string; filename: string; mime: string }>('catalog', 'exportFile', {
        format, categoryId: categoryId ? Number(categoryId) : undefined, brandId: brandId ? Number(brandId) : undefined
      })
      if (r.cancelled) return
      if (r.bytesBase64) downloadBase64(r)
      toast(r.path ? `Exported to ${r.path}` : 'Export ready', 'good')
    } catch (e) { toast(errMsg(e), 'bad') }
  }

  const doPackage = async (what: 'export' | 'import') => {
    try {
      if (what === 'export') {
        const r = await call<{ path?: string; cancelled?: boolean; bytesBase64?: string; filename: string; mime: string }>('catalog', 'packageExport', { gzip: true })
        if (r.cancelled) return
        if (r.bytesBase64) downloadBase64(r)
        toast(r.path ? `Catalog package saved to ${r.path}` : 'Catalog package ready', 'good')
      } else {
        const picked = await call<{ path?: string; cancelled?: boolean }>('catalog', 'pickFile', { exts: ['json', 'gz'] })
        if (!picked.path) return
        const r = await call<{ counts: Record<string, { created: number; updated: number }>; conflicts: unknown[] }>('catalog', 'packageImport', { path: picked.path, dryRun: true })
        const c = r.counts
        if (!confirm(`Package preview: ${c.products.created} new / ${c.products.updated} updated products, ${c.variants.created} new / ${c.variants.updated} updated variants, ${r.conflicts.length} conflict(s). Apply it?`)) return
        await call('catalog', 'packageImport', { path: picked.path })
        toast('Catalog package merged', 'good')
        refresh()
      }
    } catch (e) { toast(errMsg(e), 'bad') }
  }

  const generateMissing = async () => {
    // say exactly which numbers will be used, so the owner sees the prefix before anything is written
    let next = ''
    try { next = (await call<Record<string, string>>('catalog', 'getSettings')).nextBarcode ?? '' } catch { /* the server reports the problem below */ }
    if (!confirm(`Give a barcode to every active item that has none?${next ? `\n\nNumbering starts at ${next} and counts up by one.` : ''}`)) return
    await bulk(async () => {
      const r = await call<{ assigned: number }>('catalog', 'generateMissingBarcodes', {})
      toast(`${r.assigned} barcode(s) generated`, 'good')
    }, 'Done')
  }

  /** Open the label dialog for the selected products (all their active variants that have a barcode). */
  const openLabels = async (productIds: number[]) => {
    try {
      const variantIds: number[] = []
      let skipped = 0
      for (const id of productIds.slice(0, 200)) {
        const p = await call<ProductDetail>('catalog', 'get', { id })
        for (const v of p.variants.filter((x) => x.active)) (v.barcode ? variantIds.push(v.id) : skipped++)
      }
      if (!variantIds.length) return toast(skipped ? 'None of the selected items has a barcode yet. Use "Generate missing barcodes" first.' : 'Select products first', 'bad')
      if (skipped) toast(`${skipped} item(s) without a barcode were left out`, 'info')
      setLabelIds(variantIds)
    } catch (e) { toast(errMsg(e), 'bad') }
  }

  const cols: Column<ProductListRow>[] = [
    { key: 'sel', header: '', width: '32px', render: (r) => <input type="checkbox" checked={selected.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /> },
    { key: 'name', header: 'Product', render: (r) => <span>{r.name} {r.variantCount > 1 && <Badge>{r.variantCount} variants</Badge>}</span> },
    { key: 'sku', header: 'SKU' },
    { key: 'barcode', header: 'Barcode', render: (r) => r.barcode ?? <span className="muted">—</span> },
    { key: 'trackUnits', header: 'Unit codes', render: (r) => (r.trackUnits ? <Badge tone="good">{r.unitPrefix ? (/^[1-9]\d{3}$/.test(r.unitPrefix) ? `${r.unitPrefix}000001…` : `${r.unitPrefix}-NNNN`) : 'tracked'}</Badge> : <span className="muted">—</span>) },
    { key: 'category', header: 'Category', render: (r) => r.category ?? '' },
    { key: 'gst', header: 'GST', align: 'right', render: (r) => `${bpToPct(r.taxRateBp)}%` },
    { key: 'price', header: 'Price', align: 'right', render: (r) => (r.variantCount > 1 && r.minPrice !== r.maxPrice ? `${formatINR(r.minPrice)} – ${formatINR(r.maxPrice)}` : formatINR(r.price)) },
    { key: 'stock', header: 'Stock', align: 'right', render: (r) => (r.trackStock ? <span>{r.stock} {r.lowStock && <Badge tone="warn">low</Badge>}</span> : <span className="muted">n/a</span>) },
    { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'good' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'label', header: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" title="Print barcode labels" aria-label={`Print label for ${r.name}`} onClick={(e) => { e.stopPropagation(); void openLabels([r.id]) }}>Print label</Button> }
  ]

  return (
    <div>
      <PageHeader
        title="Products" subtitle={`${total} item${total === 1 ? '' : 's'}`}
        actions={<>
          {canEdit && <Button variant="primary" onClick={() => setEditing(null)}>+ Add product</Button>}
          {can('catalog.import') && <Button onClick={() => setShowImport(true)}>Import</Button>}
          {can('catalog.import') && <Button onClick={() => void doExport('csv')}>Export CSV</Button>}
          {can('catalog.import') && <Button onClick={() => void doExport('xlsx')}>Export Excel</Button>}
          {can('catalog.import') && <Button onClick={() => void doPackage('export')} title="Single file to copy the catalog to another POS">Catalog package ↓</Button>}
          {can('catalog.import') && <Button onClick={() => void doPackage('import')}>Catalog package ↑</Button>}
          {canEdit && <Button onClick={() => void generateMissing()}>Generate missing barcodes</Button>}
          {canEdit && <Button onClick={() => setShowNumbering(true)} title="Prefix and running number of the barcodes the app generates">Barcode numbering</Button>}
        </>}
      />
      <Card>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <Input placeholder="Search name, SKU or scan barcode…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280, flex: '1 1 240px', maxWidth: 360 }} autoFocus />
          <Select style={{ width: 'auto', maxWidth: 200 }} value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(0) }}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
          </Select>
          <Select style={{ width: 'auto', maxWidth: 180 }} value={brandId} onChange={(e) => { setBrandId(e.target.value); setPage(0) }}>
            <option value="">All brands</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select style={{ width: 'auto' }} value={active} onChange={(e) => { setActive(e.target.value); setPage(0) }}>
            <option value="1">Active</option><option value="0">Inactive</option><option value="">All</option>
          </Select>
          <label><input type="checkbox" checked={lowStock} onChange={(e) => { setLowStock(e.target.checked); setPage(0) }} /> Low stock</label>
          <label><input type="checkbox" checked={noBarcode} onChange={(e) => { setNoBarcode(e.target.checked); setPage(0) }} /> No barcode</label>
        </div>
        {selected.size > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <strong>{selected.size} selected</strong>
            {canEdit && <Button onClick={() => void bulk(() => call('catalog', 'setActive', { ids, active: true }), 'Activated')}>Activate</Button>}
            {can('catalog.delete') && <Button onClick={() => void bulk(() => call('catalog', 'setActive', { ids, active: false }), 'Deactivated')}>Deactivate</Button>}
            {canEdit && (
              <>
                <Select value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
                  <option value="">Assign category…</option>
                  {categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
                </Select>
                <Button disabled={!bulkCat} onClick={() => void bulk(() => call('catalog', 'assignCategory', { ids, categoryId: Number(bulkCat) }), 'Category assigned')}>Apply</Button>
              </>
            )}
            <Button onClick={() => void openLabels(ids)}>Print labels</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Spinner /> : (
          <Table columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r.id) : undefined} />
        )}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <div className="row">
            <Button disabled={rows.length === 0} onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>Select page</Button>
          </div>
          <div className="row">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</Button>
            <span className="muted">Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE))}</span>
            <Button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next ›</Button>
          </div>
        </div>
      </Card>

      <ProductForm
        open={editing !== undefined} productId={editing ?? null} onClose={() => setEditing(undefined)}
        onSaved={list.reload} categories={categories} brands={brands} reloadTaxonomy={reloadTaxonomy}
      />
      <ImportWizard open={showImport} onClose={() => setShowImport(false)} onDone={refresh} />
      <LabelPrintDialog open={labelIds !== null} onClose={() => setLabelIds(null)} variantIds={labelIds ?? []} />
      <BarcodeNumberingDialog open={showNumbering} onClose={() => setShowNumbering(false)} />

    </div>
  )
}
