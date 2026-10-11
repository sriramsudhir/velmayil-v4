import type { Migration } from '../migrate'

/**
 * Performance pass (range 800-899, additive indexes only).
 *  - idx_sales_voided: the dashboard history cache fingerprints "how many sales were ever voided / when was the last void"
 *    without scanning the sales table.
 *  - idx_variants_reorder: low-stock counts/lists only look at variants that have a reorder level.
 */
export const migration: Migration = {
  version: 800,
  name: 'perf_indexes',
  sql: `
CREATE INDEX IF NOT EXISTS idx_sales_voided ON sales(voided_at) WHERE voided_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_variants_reorder ON product_variants(reorder_level) WHERE reorder_level > 0;
`
}
