# POS -> Printing requests

The POS renderer (`src/renderer/modules/pos/printAdapter.ts`) calls these `printing` renderer-service methods and
guards for them being missing (it then shows "Sale completed. Printing failed." with Retry / Reprint / Save PDF / Select printer).

1. `renderInvoiceHtml({ saleId } | { returnId }, template: 'receipt58'|'receipt80'|'invoiceA4'|'invoiceA5')` -> `{ html }`
   (per ARCHITECTURE.md). Sales document data lives in `sales / sale_items / sale_payments`; `sale_payments.amount` is
   stored NET of change (SUM = sales.total); `sales.paid` is the tendered amount and `sales.change_given` the change.
   `sale_items.discount` already includes the allocated share of the bill discount; `sale_items.line_total` includes tax
   in both inclusive and exclusive modes. Returns: `sale_returns.total` = refund, `tax` = tax reversed, `subtotal` = total - tax.
2. `print({ html, printerProfileId?, paper: '58'|'80'|'A4'|'A5' })` -> `{ ok, error? }`.
3. `exportPdf({ html, path })` is called with `path` = a bare file name like `INV-2026-000001.pdf`. Please treat a
   non-absolute path as "show a save dialog (suggested name = path)" and return `{ path }` of the saved file.
4. Optional: a method returning printer profiles for the "Select printer" action. The adapter tries, in order,
   `listPrinterProfiles`, `listProfiles`, `printerProfiles` and expects `[{ id, name, deviceName?, kind? }]` or `{ rows }`.
