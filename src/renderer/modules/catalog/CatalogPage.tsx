import { useState } from 'react'
import { Button, useAsync } from '@/ui'
import { call } from '@/lib/api'
import { useLiveRefresh } from '@/lib/live'
import { ProductsTab } from './ProductsTab'
import { TaxonomyTab } from './TaxonomyTab'
import { GridTab } from './GridTab'
import type { Brand, Category } from './types'

export function CatalogPage() {
  const [tab, setTab] = useState<'products' | 'grid' | 'taxonomy'>('products')
  const cats = useAsync(() => call<Category[]>('catalog', 'listCategories'), [])
  const brands = useAsync(() => call<Brand[]>('catalog', 'listBrands'), [])
  const reload = () => { cats.reload(); brands.reload() }
  // categories/brands (and their product counts) follow edits made anywhere: other screens, windows, synced terminals
  useLiveRefresh(['catalog', 'pos', 'inventory', 'purchases'], reload)
  return (
    <div className="page">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <Button variant={tab === 'products' ? 'primary' : 'default'} onClick={() => setTab('products')}>Products</Button>
        <Button variant={tab === 'grid' ? 'primary' : 'default'} onClick={() => setTab('grid')}>Spreadsheet</Button>
        <Button variant={tab === 'taxonomy' ? 'primary' : 'default'} onClick={() => setTab('taxonomy')}>Categories &amp; Brands</Button>
      </div>
      {tab === 'products' && <ProductsTab categories={cats.data ?? []} brands={brands.data ?? []} reloadTaxonomy={reload} />}
      {tab === 'grid' && <GridTab categories={cats.data ?? []} brands={brands.data ?? []} reloadTaxonomy={reload} />}
      {tab === 'taxonomy' && <TaxonomyTab categories={cats.data ?? []} brands={brands.data ?? []} reload={reload} />}
    </div>
  )
}
