import type { Migration } from '../migrate'

const NOW = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

/**
 * UNIT CODES (range 900-999). Every physical unit of a "track_units" product gets its own code PREFIX-NNNN
 * (prefix is per product, 2-8 chars A-Z0-9, unique across products; suffix 0001-9999, sequential per prefix).
 *  - products.track_units / products.unit_prefix            (prefix upper-case, unique, frozen once units exist)
 *  - product_units                                          (one row per physical unit; never deleted, code immutable)
 *  - unit_sequences                                         (last issued suffix per prefix; gap-free, bumped by sync apply)
 *  - stock_count_units                                      (unit codes scanned during a stock count)
 *  - triggers keep unit codes out of the barcode / alias / SKU namespace
 */
export const migration: Migration = {
  version: 900,
  name: 'unit_codes',
  sql: `
ALTER TABLE products ADD COLUMN track_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN unit_prefix TEXT;
CREATE UNIQUE INDEX idx_products_unit_prefix ON products(unit_prefix COLLATE NOCASE) WHERE unit_prefix IS NOT NULL;

CREATE TRIGGER trg_products_unit_prefix_ins BEFORE INSERT ON products
WHEN (NEW.unit_prefix IS NOT NULL AND (length(NEW.unit_prefix) NOT BETWEEN 2 AND 8 OR NEW.unit_prefix GLOB '*[^A-Z0-9]*'))
  OR (NEW.track_units NOT IN (0,1)) OR (NEW.track_units = 1 AND NEW.unit_prefix IS NULL)
BEGIN SELECT RAISE(ABORT, 'unit prefix must be 2-8 upper-case letters/digits, and is required for unit tracking'); END;
CREATE TRIGGER trg_products_unit_prefix_upd BEFORE UPDATE OF unit_prefix, track_units ON products
WHEN (NEW.unit_prefix IS NOT NULL AND (length(NEW.unit_prefix) NOT BETWEEN 2 AND 8 OR NEW.unit_prefix GLOB '*[^A-Z0-9]*'))
  OR (NEW.track_units NOT IN (0,1)) OR (NEW.track_units = 1 AND NEW.unit_prefix IS NULL)
BEGIN SELECT RAISE(ABORT, 'unit prefix must be 2-8 upper-case letters/digits, and is required for unit tracking'); END;
CREATE TRIGGER trg_products_unit_prefix_frozen BEFORE UPDATE OF unit_prefix ON products
WHEN NEW.unit_prefix IS NOT OLD.unit_prefix AND OLD.unit_prefix IS NOT NULL
 AND EXISTS (SELECT 1 FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE v.product_id = OLD.id)
 AND COALESCE((SELECT last_seq FROM unit_sequences WHERE prefix = OLD.unit_prefix), 0) < 9999
BEGIN SELECT RAISE(ABORT, 'the unit prefix cannot change once unit codes exist (unless its 9999 codes are used up)'); END;

CREATE TABLE product_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  prefix TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 9999),
  code TEXT NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 7 AND 13),
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold','returned','void')),
  sale_id INTEGER REFERENCES sales(id),
  sale_item_id INTEGER REFERENCES sale_items(id),
  purchase_id INTEGER REFERENCES purchases(id),
  location_id INTEGER REFERENCES locations(id),
  void_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT ${NOW},
  updated_at INTEGER NOT NULL DEFAULT ${NOW},
  UNIQUE (prefix, seq)
);
CREATE INDEX idx_units_variant ON product_units(variant_id, status);
CREATE INDEX idx_units_sale ON product_units(sale_id);
CREATE INDEX idx_units_sale_item ON product_units(sale_item_id);
CREATE INDEX idx_units_purchase ON product_units(purchase_id);
CREATE INDEX idx_units_loc ON product_units(variant_id, location_id, status);

CREATE TRIGGER trg_units_no_delete BEFORE DELETE ON product_units
BEGIN SELECT RAISE(ABORT, 'unit codes are never deleted'); END;
CREATE TRIGGER trg_units_code_immutable BEFORE UPDATE ON product_units
WHEN NEW.code IS NOT OLD.code OR NEW.uuid IS NOT OLD.uuid OR NEW.prefix IS NOT OLD.prefix OR NEW.seq IS NOT OLD.seq OR NEW.variant_id IS NOT OLD.variant_id
BEGIN SELECT RAISE(ABORT, 'a unit code (and its product) can never change'); END;

CREATE TABLE unit_sequences (
  prefix TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 9999)
);

CREATE TABLE stock_count_units (
  count_id INTEGER NOT NULL REFERENCES stock_counts(id),
  code TEXT NOT NULL,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  scanned_at INTEGER NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (count_id, code)
);

-- a unit code never doubles as a barcode / alias barcode / SKU (one code resolves to exactly one thing)
CREATE TRIGGER trg_unit_vs_barcode_ins BEFORE INSERT ON product_variants
WHEN (NEW.barcode IS NOT NULL AND EXISTS (SELECT 1 FROM product_units WHERE code = upper(NEW.barcode)))
  OR EXISTS (SELECT 1 FROM product_units WHERE code = upper(NEW.sku))
BEGIN SELECT RAISE(ABORT, 'barcode/SKU already used as a unit code'); END;
CREATE TRIGGER trg_unit_vs_barcode_upd BEFORE UPDATE OF barcode, sku ON product_variants
WHEN (NEW.barcode IS NOT NULL AND EXISTS (SELECT 1 FROM product_units WHERE code = upper(NEW.barcode)))
  OR EXISTS (SELECT 1 FROM product_units WHERE code = upper(NEW.sku))
BEGIN SELECT RAISE(ABORT, 'barcode/SKU already used as a unit code'); END;
CREATE TRIGGER trg_unit_vs_alias_ins BEFORE INSERT ON variant_barcodes
WHEN EXISTS (SELECT 1 FROM product_units WHERE code = upper(NEW.barcode))
BEGIN SELECT RAISE(ABORT, 'barcode already used as a unit code'); END;
`
}
