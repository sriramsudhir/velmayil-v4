import type { Migration } from '../migrate'

/** Covering indexes so the dashboard's 30-day aggregates never touch the wide base rows (index-only scans). */
export const migration: Migration = {
  version: 401,
  name: 'reports_cover',
  sql: `
CREATE INDEX IF NOT EXISTS idx_rpt_sales_cov ON sales(created_at, voided_at, status, total, change_given, user_id);
CREATE INDEX IF NOT EXISTS idx_rpt_items_cov ON sale_items(sale_id, variant_id, category_id, qty, line_total);
CREATE INDEX IF NOT EXISTS idx_rpt_pay_cov ON sale_payments(sale_id, method, amount);
`
}
