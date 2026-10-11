import type { Migration } from '../migrate'

/** POS/Billing additions (Agent 2, range 100-199). Additive only. */
export const migration: Migration = {
  version: 100,
  name: 'pos',
  sql: `
-- client-generated idempotency key: a retried/double-clicked completeSale returns the original sale
ALTER TABLE sales ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pos_idx_sales_request ON sales(request_id) WHERE request_id IS NOT NULL;
-- user who granted approval (discount above role limit); NULL when none was needed
ALTER TABLE sales ADD COLUMN approved_by INTEGER;
-- shift that was open when the sale was voided (cash taken back out of that drawer)
ALTER TABLE sales ADD COLUMN void_shift_id INTEGER;
ALTER TABLE sales ADD COLUMN void_approved_by INTEGER;

ALTER TABLE sale_returns ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pos_idx_sale_returns_request ON sale_returns(request_id) WHERE request_id IS NOT NULL;
-- cash that left the drawer for this refund (drives shift expected cash)
ALTER TABLE sale_returns ADD COLUMN refund_cash INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sale_returns ADD COLUMN approved_by INTEGER;
CREATE INDEX IF NOT EXISTS pos_idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS pos_idx_sale_return_items_item ON sale_return_items(sale_item_id);

CREATE INDEX IF NOT EXISTS pos_idx_sales_shift ON sales(shift_id);
CREATE INDEX IF NOT EXISTS pos_idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS pos_idx_shifts_pos ON shifts(pos_id, closed_at);
`
}
