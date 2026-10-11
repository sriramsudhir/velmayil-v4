import type { Migration } from '../migrate'

/** Catalog (Agent 3) indexes: filters, case-insensitive SKU lookups, alias barcode joins, sync/merge by updated_at. */
export const migration: Migration = {
  version: 200,
  name: 'catalog_indexes',
  sql: `
CREATE INDEX IF NOT EXISTS idx_variants_sku_nocase ON product_variants(sku COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at);
CREATE INDEX IF NOT EXISTS idx_variant_barcodes_variant ON variant_barcodes(variant_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
`
}
