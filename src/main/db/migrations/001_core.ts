import type { Migration } from '../migrate'

const NOW = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

/**
 * CORE SCHEMA. Conventions:
 *  - money = INTEGER paise; tax rates = INTEGER basis points (1800 = 18%); timestamps = INTEGER epoch ms (UTC)
 *  - syncable entities carry a `uuid` (globally unique across POS terminals) + integer PK for local FKs
 *  - never DELETE business records; use `active`/`status`
 * Additive changes by other modules go in their own numbered migration file (see ARCHITECTURE.md).
 */
export const migration: Migration = {
  version: 1,
  name: 'core',
  sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT ${NOW}
);

CREATE TABLE pos_terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_local INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);

CREATE TABLE locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ---------- users / security ----------
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL DEFAULT '[]',
  max_discount_bp INTEGER NOT NULL DEFAULT 10000,
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT ${NOW},
  updated_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity TEXT, entity_id TEXT,
  requested_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  reason TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT ${NOW},
  user_id INTEGER, user_name TEXT,
  pos_id INTEGER, pos_code TEXT,
  entity TEXT NOT NULL, entity_id TEXT,
  action TEXT NOT NULL,
  old_json TEXT, new_json TEXT, note TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

-- ---------- business profile (versioned; ONE authoritative source) ----------
CREATE TABLE logo_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  width_px INTEGER NOT NULL, height_px INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  print_bytes BLOB,
  print_mime TEXT,
  size_bytes INTEGER NOT NULL,
  has_transparency INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE business_profile_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL UNIQUE,
  shop_name TEXT NOT NULL, legal_name TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL, short_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', pin_code TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '', pan TEXT NOT NULL DEFAULT '', footer_text TEXT NOT NULL DEFAULT '',
  logo_asset_id INTEGER REFERENCES logo_assets(id),
  logo_settings_json TEXT NOT NULL DEFAULT '{}',
  header_settings_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW},
  created_by INTEGER, pos_id INTEGER
);
CREATE UNIQUE INDEX idx_bpv_active ON business_profile_versions(is_active) WHERE is_active = 1;

-- ---------- catalog ----------
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE, parent_id INTEGER REFERENCES categories(id),
  active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id), brand_id INTEGER REFERENCES brands(id),
  hsn TEXT NOT NULL DEFAULT '',
  tax_rate_bp INTEGER NOT NULL DEFAULT 1800,
  unit TEXT NOT NULL DEFAULT 'pcs',
  image_id INTEGER REFERENCES product_images(id),
  track_stock INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT ${NOW}, updated_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_products_name ON products(name COLLATE NOCASE);
-- A sellable unit. Every product has at least one variant (a default variant with name '' for simple products).
CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  mrp INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT ${NOW}, updated_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE TABLE variant_barcodes (
  barcode TEXT PRIMARY KEY, variant_id INTEGER NOT NULL REFERENCES product_variants(id)
);

-- ---------- inventory ----------
CREATE TABLE stock_levels (
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, location_id)
);
-- append-only ledger. type: opening|purchase|sale|sale_return|adjustment|count|transfer_in|transfer_out|supplier_return|void
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref_type TEXT, ref_id TEXT,
  unit_cost INTEGER,
  note TEXT, user_id INTEGER, pos_id INTEGER,
  ts INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_moves_variant ON stock_movements(variant_id, ts);
CREATE INDEX idx_moves_ref ON stock_movements(ref_type, ref_id);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', gstin TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  number TEXT NOT NULL UNIQUE, supplier_id INTEGER REFERENCES suppliers(id), supplier_invoice_no TEXT NOT NULL DEFAULT '',
  location_id INTEGER NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'received',
  subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  qty INTEGER NOT NULL, unit_cost INTEGER NOT NULL, tax_rate_bp INTEGER NOT NULL DEFAULT 0, tax_amount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL
);
CREATE TABLE supplier_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER REFERENCES suppliers(id), location_id INTEGER NOT NULL REFERENCES locations(id),
  total INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE supplier_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL REFERENCES supplier_returns(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id), qty INTEGER NOT NULL, unit_cost INTEGER NOT NULL
);
CREATE TABLE stock_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, number TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id), status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at INTEGER NOT NULL DEFAULT ${NOW}, applied_at INTEGER
);
CREATE TABLE stock_count_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, count_id INTEGER NOT NULL REFERENCES stock_counts(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id), expected_qty INTEGER NOT NULL, counted_qty INTEGER
);
CREATE TABLE stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, number TEXT NOT NULL UNIQUE,
  from_location_id INTEGER NOT NULL REFERENCES locations(id), to_location_id INTEGER NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'completed', note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE stock_transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id), qty INTEGER NOT NULL
);

-- ---------- sales ----------
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', gstin TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  pos_id INTEGER NOT NULL REFERENCES pos_terminals(id), user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at INTEGER NOT NULL DEFAULT ${NOW}, closed_at INTEGER,
  opening_cash INTEGER NOT NULL DEFAULT 0, closing_cash INTEGER, expected_cash INTEGER, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE invoice_sequences (
  series TEXT NOT NULL, year INTEGER NOT NULL, next_no INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (series, year)
);
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  invoice_no TEXT NOT NULL UNIQUE,
  pos_id INTEGER NOT NULL REFERENCES pos_terminals(id), shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER NOT NULL REFERENCES users(id), customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'completed',
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0,
  round_off INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0, change_given INTEGER NOT NULL DEFAULT 0,
  prices_include_tax INTEGER NOT NULL DEFAULT 1,
  profile_version_id INTEGER NOT NULL REFERENCES business_profile_versions(id),
  note TEXT NOT NULL DEFAULT '', void_reason TEXT, voided_by INTEGER, voided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_pos ON sales(pos_id, created_at);
CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  name TEXT NOT NULL, sku TEXT NOT NULL, barcode TEXT, hsn TEXT NOT NULL DEFAULT '',
  category_id INTEGER, brand_id INTEGER,
  qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, mrp INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0, tax_rate_bp INTEGER NOT NULL DEFAULT 0, tax_amount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL, price_overridden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_variant ON sale_items(variant_id);
CREATE TABLE sale_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT
);
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE TABLE held_carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
  pos_id INTEGER NOT NULL, user_id INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '',
  cart_json TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, return_no TEXT NOT NULL UNIQUE,
  sale_id INTEGER NOT NULL REFERENCES sales(id), pos_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  shift_id INTEGER, subtotal INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  refund_method TEXT NOT NULL DEFAULT 'cash', reason TEXT NOT NULL DEFAULT '',
  profile_version_id INTEGER REFERENCES business_profile_versions(id),
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
CREATE TABLE sale_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL REFERENCES sale_returns(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), variant_id INTEGER NOT NULL,
  qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, tax_amount INTEGER NOT NULL DEFAULT 0, line_total INTEGER NOT NULL,
  restock INTEGER NOT NULL DEFAULT 1
);

-- ---------- printing ----------
-- kind: receipt58|receipt80|invoiceA4|invoiceA5|label_barcode|label_product|report_sales|report_purchase|report_inventory
CREATE TABLE print_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT ${NOW},
  UNIQUE(kind, name)
);
-- printer profile kind: receipt58|receipt80|a4|a5|label ; device_name '' = system default printer
CREATE TABLE printer_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  calibration_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0, pos_id INTEGER
);

-- ---------- sync / backup ----------
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_uuid TEXT NOT NULL, op TEXT NOT NULL,
  payload_json TEXT NOT NULL, pos_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT ${NOW}, sent_at INTEGER
);
CREATE INDEX idx_sync_status ON sync_queue(status, id);
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW}
);
`
}
