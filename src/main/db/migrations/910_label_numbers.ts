import type { Migration } from '../migrate'

const NOW = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

/**
 * LABEL NUMBERS (unit codes, range 900-999). Every printed barcode label carries its own number: 10 digits = a 4-digit product
 * prefix (1000-9999) + a 6-digit running suffix (000001-999999), e.g. 2000000190, 2000000191. Older PREFIX-NNNN codes stay valid.
 *  - product_units.seq            1..9999  ->  1..999999 for a 4-digit label prefix (a PREFIX-NNNN prefix still stops at 9999);
 *                                 the CHECK is widened by rebuilding the table, every row and its id is kept
 *  - unit_sequences.last_seq      0..9999  ->  0..999999 (same rule)
 *  - product_units.label_printed_at   when the unit's own label was (first) printed; NULL = it never got one.
 *      Units that existed before this migration belong to products that were tracked by hand and are taken as labelled.
 *  - products.unit_auto           1 = unit tracking was switched on automatically by "Print barcode label"; only for these
 *      products may a piece WITHOUT a label of its own still be billed by the shared product barcode.
 * SQLite cannot alter a CHECK, so product_units / unit_sequences are copied into new tables. The triggers that mention them are
 * dropped first and re-created afterwards (a rename with a dangling trigger reference would fail).
 */
export const migration: Migration = {
  version: 910,
  name: 'label_numbers',
  sql: `
DROP TRIGGER IF EXISTS trg_products_unit_prefix_frozen;
DROP TRIGGER IF EXISTS trg_unit_vs_barcode_ins;
DROP TRIGGER IF EXISTS trg_unit_vs_barcode_upd;
DROP TRIGGER IF EXISTS trg_unit_vs_alias_ins;
DROP TRIGGER IF EXISTS trg_units_no_delete;
DROP TRIGGER IF EXISTS trg_units_code_immutable;

ALTER TABLE products ADD COLUMN unit_auto INTEGER NOT NULL DEFAULT 0;

CREATE TABLE product_units_910 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  prefix TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 999999 AND (seq <= 9999 OR prefix GLOB '[1-9][0-9][0-9][0-9]')),
  code TEXT NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 7 AND 13),
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold','returned','void')),
  sale_id INTEGER REFERENCES sales(id),
  sale_item_id INTEGER REFERENCES sale_items(id),
  purchase_id INTEGER REFERENCES purchases(id),
  location_id INTEGER REFERENCES locations(id),
  void_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT ${NOW},
  updated_at INTEGER NOT NULL DEFAULT ${NOW},
  label_printed_at INTEGER,
  UNIQUE (prefix, seq)
);
INSERT INTO product_units_910(id,uuid,variant_id,prefix,seq,code,status,sale_id,sale_item_id,purchase_id,location_id,void_reason,created_at,updated_at,label_printed_at)
  SELECT id,uuid,variant_id,prefix,seq,code,status,sale_id,sale_item_id,purchase_id,location_id,void_reason,created_at,updated_at,created_at FROM product_units ORDER BY id;
DROP TABLE product_units;
ALTER TABLE product_units_910 RENAME TO product_units;
CREATE INDEX idx_units_variant ON product_units(variant_id, status);
CREATE INDEX idx_units_sale ON product_units(sale_id);
CREATE INDEX idx_units_sale_item ON product_units(sale_item_id);
CREATE INDEX idx_units_purchase ON product_units(purchase_id);
CREATE INDEX idx_units_loc ON product_units(variant_id, location_id, status);
CREATE INDEX idx_units_unlabelled ON product_units(variant_id, location_id) WHERE label_printed_at IS NULL;

CREATE TRIGGER trg_units_no_delete BEFORE DELETE ON product_units
BEGIN SELECT RAISE(ABORT, 'unit codes are never deleted'); END;
CREATE TRIGGER trg_units_code_immutable BEFORE UPDATE ON product_units
WHEN NEW.code IS NOT OLD.code OR NEW.uuid IS NOT OLD.uuid OR NEW.prefix IS NOT OLD.prefix OR NEW.seq IS NOT OLD.seq OR NEW.variant_id IS NOT OLD.variant_id
BEGIN SELECT RAISE(ABORT, 'a unit code (and its product) can never change'); END;

CREATE TABLE unit_sequences_910 (
  prefix TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 999999 AND (last_seq <= 9999 OR prefix GLOB '[1-9][0-9][0-9][0-9]'))
);
INSERT INTO unit_sequences_910(prefix,last_seq) SELECT prefix,last_seq FROM unit_sequences;
DROP TABLE unit_sequences;
ALTER TABLE unit_sequences_910 RENAME TO unit_sequences;

-- a prefix is frozen while its numbers are not used up: 999999 for a 4-digit label prefix, 9999 for a PREFIX-NNNN prefix
CREATE TRIGGER trg_products_unit_prefix_frozen BEFORE UPDATE OF unit_prefix ON products
WHEN NEW.unit_prefix IS NOT OLD.unit_prefix AND OLD.unit_prefix IS NOT NULL
 AND EXISTS (SELECT 1 FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE v.product_id = OLD.id)
 AND COALESCE((SELECT last_seq FROM unit_sequences WHERE prefix = OLD.unit_prefix), 0)
     < CASE WHEN OLD.unit_prefix GLOB '[1-9][0-9][0-9][0-9]' THEN 999999 ELSE 9999 END
BEGIN SELECT RAISE(ABORT, 'the unit prefix cannot change once unit codes exist (unless all its codes are used up)'); END;

CREATE TRIGGER trg_products_unit_auto_ins BEFORE INSERT ON products
WHEN NEW.unit_auto NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'unit_auto must be 0 or 1'); END;
CREATE TRIGGER trg_products_unit_auto_upd BEFORE UPDATE OF unit_auto ON products
WHEN NEW.unit_auto NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'unit_auto must be 0 or 1'); END;

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
