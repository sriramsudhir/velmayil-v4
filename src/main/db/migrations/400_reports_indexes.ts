import type { Migration } from '../migrate'

/** Reports module (read-only): indexes that keep report and dashboard queries fast on large sales tables. */
export const migration: Migration = {
  version: 400,
  name: 'reports_indexes',
  sql: `
CREATE INDEX IF NOT EXISTS idx_rpt_sales_user ON sales(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rpt_sales_customer ON sales(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rpt_sales_shift ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_rpt_sales_status ON sales(status, created_at);
CREATE INDEX IF NOT EXISTS idx_rpt_returns_created ON sale_returns(created_at);
CREATE INDEX IF NOT EXISTS idx_rpt_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_rpt_return_items_return ON sale_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_rpt_return_items_item ON sale_return_items(sale_item_id);
CREATE INDEX IF NOT EXISTS idx_rpt_shifts_opened ON shifts(opened_at);
CREATE INDEX IF NOT EXISTS idx_rpt_purchases_created ON purchases(created_at);
CREATE INDEX IF NOT EXISTS idx_rpt_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_rpt_moves_ts ON stock_movements(ts);
CREATE INDEX IF NOT EXISTS idx_rpt_audit_user ON audit_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_rpt_audit_action ON audit_log(action, ts);
`
}
