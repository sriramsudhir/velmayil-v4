# Request: printing/businessProfile (Agent 6) -> sync (Agent 8)

Inbound sync of the shop profile must go through the profile service so version rules and the logo hand-off are respected:

- entity `business_profile_versions` (payload = `Snapshot` from `app.enqueueSnapshot`):
  `app.get<BusinessProfileService>('businessProfile').applySynced(snapshot)`
  returns `{ adopted, activated, pending?, versionId? }`. It never rewrites local history, renumbers on version clashes,
  and activates the remote version only when it is newer (`created_at`, then `version`). It does NOT re-enqueue (no echo).
- entity `logo_assets` (`entity_uuid` = sha256 of the stored bytes, payload `{ sha256, mime, widthPx, heightPx, sizeBytes, hasTransparency, bytesBase64 }`):
  `...applySyncedLogo({ sha256, bytesBase64 })`. A profile version whose logo has not arrived yet is parked
  (setting `profile.pending_sync`) and released automatically when its logo arrives, so either order works.
- Do not write `business_profile_versions` / `logo_assets` directly.

# Notes for other modules

- POS: after `completeSale`, render with `app.get<PrintingService>('printing').renderInvoiceHtml({ saleId, template })`
  then `await printing.print({ html, paper, docRef })`. `print()` never throws for printer problems (`{ ok:false, error, logId }`)
  and failed jobs are retryable via `retryPrint({ logId })`.
- Catalog / any module: labels via `call('printing','renderLabelHtml', { variantIds:[{variantId,copies}], template })`;
  reusable preview component: `import { PrintPreview } from '@/modules/printing/PrintPreview'`.
- Reports: `call('printing','renderReportHtml', { title, subtitle, columns:[{key,header,align?,format?}], rows, totals? })`
  (`format`: money = paise, int, date/datetime = epoch ms) returns `{ html, widthMm }` with the profile header.
