import type { Migration } from '../migrate'

/**
 * POS/Billing (range 100-199): permanent "Delete order" (pos.deleteSale).
 *  - deleted_sales : tombstone per deleted invoice (by sales.uuid). Kept forever so a synced / re-sent copy of the bill is never
 *                    re-created, and so other terminals learn about the delete. Invoice numbers are never reused.
 *  - the "no hard delete" triggers of 002_integrity on sales / lines / payments / returns stay in force, EXCEPT for a sale that
 *    has a tombstone: the tombstone is written first (same transaction), which is what unlocks the delete of exactly that bill.
 *  - roles that may void a sale also get the new pos.delete permission (Owner has '*').
 */
const tombstoned = (saleIdExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM sales s JOIN deleted_sales d ON d.uuid = s.uuid WHERE s.id = ${saleIdExpr})`

export const migration: Migration = {
  version: 110,
  name: 'sale_delete',
  sql: `
CREATE TABLE deleted_sales (
  uuid TEXT PRIMARY KEY,                    -- sales.uuid of the deleted invoice
  invoice_no TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL,
  deleted_by INTEGER,                       -- local users.id (NULL when the delete arrived by sync)
  deleted_by_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  origin_device TEXT NOT NULL DEFAULT ''    -- pos_terminals.uuid of the terminal where it was deleted
);
CREATE INDEX idx_deleted_sales_at ON deleted_sales(deleted_at);

DROP TRIGGER trg_sales_no_delete;
CREATE TRIGGER trg_sales_no_delete BEFORE DELETE ON sales
WHEN NOT EXISTS (SELECT 1 FROM deleted_sales d WHERE d.uuid = OLD.uuid)
BEGIN SELECT RAISE(ABORT, 'sales cannot be deleted; void them'); END;

DROP TRIGGER trg_sale_items_no_delete;
CREATE TRIGGER trg_sale_items_no_delete BEFORE DELETE ON sale_items
WHEN ${tombstoned('OLD.sale_id')}
BEGIN SELECT RAISE(ABORT, 'sale lines cannot be deleted'); END;

DROP TRIGGER trg_sale_payments_no_delete;
CREATE TRIGGER trg_sale_payments_no_delete BEFORE DELETE ON sale_payments
WHEN ${tombstoned('OLD.sale_id')}
BEGIN SELECT RAISE(ABORT, 'sale payments cannot be deleted'); END;

DROP TRIGGER trg_sale_returns_no_delete;
CREATE TRIGGER trg_sale_returns_no_delete BEFORE DELETE ON sale_returns
WHEN ${tombstoned('OLD.sale_id')}
BEGIN SELECT RAISE(ABORT, 'sale returns cannot be deleted'); END;

DROP TRIGGER trg_sale_return_items_no_delete;
CREATE TRIGGER trg_sale_return_items_no_delete BEFORE DELETE ON sale_return_items
WHEN ${tombstoned('(SELECT r.sale_id FROM sale_returns r WHERE r.id = OLD.return_id)')}
BEGIN SELECT RAISE(ABORT, 'sale return lines cannot be deleted'); END;
`,
  up: (db) => {
    for (const r of db.all<{ id: number; permissions: string }>('SELECT id, permissions FROM roles')) {
      let perms: unknown
      try {
        perms = JSON.parse(r.permissions)
      } catch {
        continue
      }
      if (!Array.isArray(perms) || perms.includes('*') || !perms.includes('pos.void') || perms.includes('pos.delete')) continue
      const at = perms.indexOf('pos.void') + 1
      db.run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify([...perms.slice(0, at), 'pos.delete', ...perms.slice(at)]), r.id)
    }
  }
}
