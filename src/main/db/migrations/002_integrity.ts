import type { Migration } from '../migrate'

/** Raises when any of the listed columns changed between OLD and NEW. */
const changed = (cols: string[]) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')

const BPV_COLS = [
  'uuid', 'version', 'shop_name', 'legal_name', 'display_name', 'short_name', 'address', 'city', 'state', 'pin_code',
  'phone', 'email', 'website', 'gstin', 'pan', 'footer_text', 'logo_asset_id', 'logo_settings_json', 'header_settings_json',
  'created_at', 'created_by', 'pos_id'
]

const noDelete = (table: string, why: string) => `
CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${why}'); END;`

/**
 * INTEGRITY / PERFORMANCE hardening of the core schema (additive; 001 is never edited).
 *  - append-only ledgers (stock_movements, audit_log), immutable profile versions & logo bytes
 *  - issued sales/returns keep their money + identity (void/paid/status remain updatable); no hard deletes
 *  - cheap CHECK-style guards via triggers (ALTER cannot add CHECKs), barcode namespace uniqueness
 *  - one local terminal / one default location, indexes for reports, returns, sync and FK lookups
 */
export const migration: Migration = {
  version: 2,
  name: 'integrity',
  sql: `
-- ---------- append-only ledgers ----------
CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
${noDelete('stock_movements', 'stock_movements is append-only')}
CREATE TRIGGER trg_stock_movements_valid BEFORE INSERT ON stock_movements
WHEN NEW.qty_delta = 0 OR NEW.type = ''
BEGIN SELECT RAISE(ABORT, 'stock movement needs a non-zero delta and a type'); END;

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
${noDelete('audit_log', 'audit_log is append-only')}

-- ---------- business profile: versions are immutable (only the is_active flag flips) ----------
CREATE TRIGGER trg_bpv_immutable BEFORE UPDATE ON business_profile_versions
WHEN ${changed(BPV_COLS)}
BEGIN SELECT RAISE(ABORT, 'business_profile_versions rows are immutable; create a new version'); END;
${noDelete('business_profile_versions', 'business_profile_versions rows cannot be deleted')}
CREATE TRIGGER trg_logo_assets_immutable BEFORE UPDATE ON logo_assets
WHEN ${changed(['sha256', 'mime', 'width_px', 'height_px', 'bytes', 'print_bytes', 'print_mime', 'size_bytes'])}
BEGIN SELECT RAISE(ABORT, 'logo_assets are immutable; upload a new asset'); END;

-- ---------- issued documents: never deleted, identity + money frozen ----------
${noDelete('sales', 'sales cannot be deleted; void them')}
${noDelete('sale_items', 'sale lines cannot be deleted')}
${noDelete('sale_payments', 'sale payments cannot be deleted')}
${noDelete('sale_returns', 'sale returns cannot be deleted')}
${noDelete('sale_return_items', 'sale return lines cannot be deleted')}
${noDelete('purchases', 'purchases cannot be deleted')}
${noDelete('supplier_returns', 'supplier returns cannot be deleted')}
${noDelete('users', 'users cannot be deleted; deactivate them')}

CREATE TRIGGER trg_sales_frozen BEFORE UPDATE ON sales
WHEN ${changed(['uuid', 'invoice_no', 'pos_id', 'user_id', 'subtotal', 'discount', 'tax', 'round_off', 'total', 'prices_include_tax', 'profile_version_id', 'created_at'])}
BEGIN SELECT RAISE(ABORT, 'issued sale is immutable (only status/void/payment fields may change)'); END;
CREATE TRIGGER trg_sale_items_frozen BEFORE UPDATE ON sale_items
WHEN ${changed(['sale_id', 'variant_id', 'qty', 'unit_price', 'discount', 'tax_rate_bp', 'tax_amount', 'line_total'])}
BEGIN SELECT RAISE(ABORT, 'sale lines are immutable'); END;
CREATE TRIGGER trg_sale_payments_frozen BEFORE UPDATE ON sale_payments
WHEN ${changed(['sale_id', 'method', 'amount'])}
BEGIN SELECT RAISE(ABORT, 'sale payments are immutable'); END;
CREATE TRIGGER trg_sale_returns_frozen BEFORE UPDATE ON sale_returns
WHEN ${changed(['uuid', 'return_no', 'sale_id', 'subtotal', 'tax', 'total', 'profile_version_id', 'created_at'])}
BEGIN SELECT RAISE(ABORT, 'issued return is immutable'); END;
CREATE TRIGGER trg_sale_return_items_frozen BEFORE UPDATE ON sale_return_items
WHEN ${changed(['return_id', 'sale_item_id', 'qty', 'unit_price', 'tax_amount', 'line_total'])}
BEGIN SELECT RAISE(ABORT, 'return lines are immutable'); END;

-- ---------- cheap integrity guards ----------
CREATE TRIGGER trg_sale_items_valid BEFORE INSERT ON sale_items
WHEN NEW.qty <= 0 OR NEW.unit_price < 0 OR NEW.line_total < 0
BEGIN SELECT RAISE(ABORT, 'sale line needs qty > 0 and non-negative amounts'); END;
CREATE TRIGGER trg_sale_payments_valid BEFORE INSERT ON sale_payments
WHEN NEW.amount < 0
BEGIN SELECT RAISE(ABORT, 'payment amount cannot be negative'); END;
CREATE TRIGGER trg_sale_return_items_valid BEFORE INSERT ON sale_return_items
WHEN NEW.qty <= 0
  OR NEW.qty + COALESCE((SELECT SUM(qty) FROM sale_return_items WHERE sale_item_id = NEW.sale_item_id), 0)
     > COALESCE((SELECT qty FROM sale_items WHERE id = NEW.sale_item_id), 0)
BEGIN SELECT RAISE(ABORT, 'return quantity exceeds the quantity sold'); END;

CREATE TRIGGER trg_products_tax_ins BEFORE INSERT ON products
WHEN NEW.tax_rate_bp < 0 OR NEW.tax_rate_bp > 10000
BEGIN SELECT RAISE(ABORT, 'tax_rate_bp must be between 0 and 10000'); END;
CREATE TRIGGER trg_products_tax_upd BEFORE UPDATE OF tax_rate_bp ON products
WHEN NEW.tax_rate_bp < 0 OR NEW.tax_rate_bp > 10000
BEGIN SELECT RAISE(ABORT, 'tax_rate_bp must be between 0 and 10000'); END;
CREATE TRIGGER trg_variants_money_ins BEFORE INSERT ON product_variants
WHEN NEW.mrp < 0 OR NEW.price < 0 OR NEW.cost < 0
BEGIN SELECT RAISE(ABORT, 'mrp/price/cost cannot be negative'); END;
CREATE TRIGGER trg_variants_money_upd BEFORE UPDATE OF mrp, price, cost ON product_variants
WHEN NEW.mrp < 0 OR NEW.price < 0 OR NEW.cost < 0
BEGIN SELECT RAISE(ABORT, 'mrp/price/cost cannot be negative'); END;

-- a code resolves to exactly one variant: primary barcodes and alias barcodes share one namespace
CREATE TRIGGER trg_alias_barcode_clash BEFORE INSERT ON variant_barcodes
WHEN EXISTS (SELECT 1 FROM product_variants WHERE barcode = NEW.barcode AND id <> NEW.variant_id)
BEGIN SELECT RAISE(ABORT, 'barcode already used by another variant'); END;
CREATE TRIGGER trg_variant_barcode_clash_ins BEFORE INSERT ON product_variants
WHEN NEW.barcode IS NOT NULL AND EXISTS (SELECT 1 FROM variant_barcodes WHERE barcode = NEW.barcode)
BEGIN SELECT RAISE(ABORT, 'barcode already used as an alias of another variant'); END;
CREATE TRIGGER trg_variant_barcode_clash_upd BEFORE UPDATE OF barcode ON product_variants
WHEN NEW.barcode IS NOT NULL AND EXISTS (SELECT 1 FROM variant_barcodes WHERE barcode = NEW.barcode AND variant_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'barcode already used as an alias of another variant'); END;

-- exactly one local terminal, at most one default location
CREATE UNIQUE INDEX idx_pos_one_local ON pos_terminals(is_local) WHERE is_local = 1;
CREATE UNIQUE INDEX idx_loc_one_default ON locations(is_default) WHERE is_default = 1;

-- ---------- sync LWW columns for tables owned by core ----------
ALTER TABLE locations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_terminals ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE locations SET updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
UPDATE pos_terminals SET updated_at = created_at;

-- ---------- indexes ----------
CREATE INDEX idx_moves_loc_variant ON stock_movements(location_id, variant_id);
CREATE INDEX idx_moves_ts ON stock_movements(ts);
CREATE INDEX idx_moves_type ON stock_movements(type, ts);
CREATE INDEX idx_stock_levels_loc ON stock_levels(location_id);
CREATE INDEX idx_sales_status ON sales(status, created_at);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_user ON sales(user_id, created_at);
CREATE INDEX idx_sales_profile ON sales(profile_version_id);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sale_payments_method ON sale_payments(method);
CREATE INDEX idx_returns_sale ON sale_returns(sale_id);
CREATE INDEX idx_returns_created ON sale_returns(created_at);
CREATE INDEX idx_return_items_return ON sale_return_items(return_id);
CREATE INDEX idx_return_items_saleitem ON sale_return_items(sale_item_id);
CREATE INDEX idx_return_items_variant ON sale_return_items(variant_id);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id, created_at);
CREATE INDEX idx_purchases_created ON purchases(created_at);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_variant ON purchase_items(variant_id);
CREATE INDEX idx_supplier_return_items ON supplier_return_items(return_id);
CREATE INDEX idx_stock_count_items ON stock_count_items(count_id);
CREATE INDEX idx_stock_transfer_items ON stock_transfer_items(transfer_id);
CREATE INDEX idx_shifts_pos ON shifts(pos_id, closed_at);
CREATE INDEX idx_shifts_user ON shifts(user_id);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_products_updated ON products(updated_at);
CREATE INDEX idx_variants_updated ON product_variants(updated_at);
CREATE INDEX idx_variant_barcodes_variant ON variant_barcodes(variant_id);
CREATE INDEX idx_held_carts_user ON held_carts(pos_id, user_id);
CREATE INDEX idx_sync_entity ON sync_queue(entity, entity_uuid);
CREATE INDEX idx_audit_user ON audit_log(user_id, ts);
CREATE INDEX idx_audit_action ON audit_log(action, ts);
CREATE INDEX idx_approvals_created ON approvals(created_at);
CREATE INDEX idx_bpv_logo ON business_profile_versions(logo_asset_id);
CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);
CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);
`
}
