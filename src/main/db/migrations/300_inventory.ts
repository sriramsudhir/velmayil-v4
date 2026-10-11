import type { Migration } from '../migrate'

const NOW = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

/** Inventory / purchases additions (Agent 4, range 300-399). Additive only. */
export const migration: Migration = {
  version: 300,
  name: 'inventory',
  sql: `
-- reasoned stock adjustments (the ledger row is written by app.moveStock; this is the business record)
CREATE TABLE stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_stock_adj_variant ON stock_adjustments(variant_id, created_at);

CREATE TABLE purchase_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'cash', note TEXT NOT NULL DEFAULT '',
  user_id INTEGER, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_purchase_payments_purchase ON purchase_payments(purchase_id);

ALTER TABLE suppliers ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN contact_person TEXT NOT NULL DEFAULT '';
ALTER TABLE purchases ADD COLUMN cancelled_at INTEGER;
ALTER TABLE purchases ADD COLUMN cancel_reason TEXT;
ALTER TABLE stock_counts ADD COLUMN category_id INTEGER REFERENCES categories(id);
ALTER TABLE stock_counts ADD COLUMN cancelled_at INTEGER;

CREATE INDEX idx_supplier_returns_supplier ON supplier_returns(supplier_id);
CREATE UNIQUE INDEX idx_count_items_unique ON stock_count_items(count_id, variant_id);
`
}
