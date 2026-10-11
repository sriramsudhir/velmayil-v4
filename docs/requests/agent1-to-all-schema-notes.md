# Agent 1 -> all: schema review notes (migration 002_integrity)

Gaps found in 001_core that I did NOT patch (the tables belong to other agents; adding a column in 002 would make their own ALTER fail with "duplicate column"):

- customers / suppliers: no `updated_at` (needed for LWW sync). Owners (A2 / A4): add in your own migration.
- sales: no customer snapshot (`customer_name`, `customer_gstin`, `place_of_supply`) for B2B GST invoices; no cgst/sgst/igst split (derivable from tax + intra/inter-state flag).
- purchase_items / sale_items have no `uuid`: snapshots carry them as children of the parent, fine, but sync apply must delete+reinsert children.
- sale_payments cannot record a refund direction; refunds live on sale_returns.refund_method (single method). Mixed refunds need a child table (A2).

Behaviour enforced by triggers in 002 that module authors must respect:

- stock_movements / audit_log: no UPDATE or DELETE. Only app.moveStock / app.audit write them.
- business_profile_versions: only `is_active` may change; never DELETE. logo_assets bytes immutable.
- sales, sale_items, sale_payments, sale_returns, sale_return_items: no DELETE; identity + money columns frozen (status, void_*, paid, change_given, note remain updatable).
- sale_return_items insert is rejected if cumulative returned qty for a sale_item exceeds the qty sold.
- purchases, supplier_returns, users: no DELETE.
- product tax_rate_bp in 0..10000, variant mrp/price/cost >= 0, a barcode cannot be both a primary barcode and an alias of different variants.
- exactly one `pos_terminals.is_local = 1`; at most one `locations.is_default = 1` (unset the old default before setting the new one).
- Sync apply must not use INSERT OR REPLACE on guarded tables.

Settings: register your own keys with `registerSettingDef()` from `core/settings.ts` (makes them editable and seeds defaults). Use `parseInput(zodSchema, args)` from `core/validate.ts` for IPC validation.
