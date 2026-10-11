# Velmayil POS - QA Report (Agent 10)

Scope: functional QA of the integrated app. Production code (`src/**`) was NOT modified. All findings below come from tests that were actually run; nothing is marked passed without a test exercising it.

## 1. Environment
- Windows 11 Home 10.0.22631 (display scale 125 %, so screenshots are 1.25x the CSS size), Electron 44.5.1, `node:sqlite`, vitest 5.0.3, @playwright/test 1.63 (`_electron`).
- Built with `npm run build` (electron-vite), driven from `out/`. Every run used a fresh temp data dir via `VELMAYIL_DATA_DIR`; `ELECTRON_RUN_AS_NODE` was unset.
- No physical printer exists on this machine (printers: OneNote, Microsoft Print to PDF, Fax, WPS PDF). No second PC / second Electron process was used.

## 2. What was run
| Suite | File | Result |
|---|---|---|
| Whole existing suite + new tests | `npm test` | 529 pass, 7 fail: 5 are the intentional defect probes below; 2 are timing-based perf tests (`tests/catalog/perf` import 5k rows, `tests/reports/perf` dashboard) that fail only when run in parallel with the heavy QA tests and PASS when run alone (flaky under load, not defects) |
| Business flow, real first-run DB (33 tests) | `tests/integration/business-flow.test.ts` | 33/33 pass |
| Profile / logo / print steps (14) | `tests/integration/profile-print-steps.test.ts` | 14/14 pass |
| Multi-POS sync, two `App` instances + `server/sync-server.mjs` over HTTP (6) | `tests/integration/multipos-sync.test.ts` | 5 pass, 1 fail (DEF-5) |
| Edge cases, rounding oracle, hostile strings, 20k perf (17) | `tests/integration/edge-cases.test.ts` | 13 pass, 4 fail (DEF-1..4) |
| Existing | `tests/integration/price-barcode.test.ts` | pass (untouched) |
| UI end-to-end, built Electron app (12) | `tests/e2e/app.spec.ts` | 12/12 pass (`npx playwright test -c tests/e2e/playwright.config.ts`) |

The 5 failing integration tests are DEFECT PROBES: they assert the correct behaviour and fail because of real bugs; they will turn green once fixed.

Renderer console errors captured during the whole UI run: **0**. Main-process errors/stderr: **0** (only Playwright's "Debugger ending" line, filtered). The sound util used by Product form/POS did not throw. Full capture: `docs/qa-screens/console-and-main-errors.json`.

Screens: `docs/qa-screens/*.png` (41 shots at 1366x768, 1920x1080 and 1024x700). I viewed wizard-free key screens (shop profile, printing, POS cart/success/after-print, POS at 1920 and 1024, dashboard, products, settings, sale detail after return). An automated horizontal-overflow detector found no page-level overflow on any screen at any size.

## 3. Chain status
| Stage | Verdict | Evidence / notes |
|---|---|---|
| INSTALL | NOT TESTED | `npm run dist` / NSIS installer was not built or run. Only the built `out/` app was launched. |
| FIRST SETUP | PASS | UI wizard (validation of username/password mismatch, review step, GSTIN upper-casing) and `setup.complete` on an empty DB; second `setup.complete` rejected (CONFLICT). |
| SHOP PROFILE | PASS | Save via UI + API; invalid GSTIN/phone/PIN/email/long name rejected; no-op save makes no version; versions immutable; audited; persisted after Electron close + relaunch (UI). |
| LOGO | PASS (PNG) | Generated PNG uploaded through the real file input (`setInputFiles`), preview natural size verified 200x100, persisted after relaunch; replace/remove/hide/size settings tested; non-image/empty/8 MB rejected. JPEG/WebP/SVG only covered by existing unit tests, not re-run end-to-end here. |
| PRODUCT IMPORT | PASS (API) | 24-row CSV with GST 5/12/18/28 and EAN-13: preview, commit, idempotent re-import, duplicate barcode/SKU rejected. The Import wizard UI was NOT driven. |
| INVENTORY | PASS | Opening stock via import and via Product form UI, purchase (stock + cost update), ledger = levels, negative stock blocked/allowed by setting, rollback of multi-line sale. |
| BARCODE | PASS | UI Generate button -> valid EAN-13; scan box at POS; old barcode charges the new price after a price edit in the UI. |
| BILLING | PASS with DEF-1 | Hand-computed totals, 100 random carts vs BigInt oracle, 100 random discount carts invariants, double-submit idempotency, round-off. Tax-exclusive mode works only via the undocumented `pos.*` key (DEF-1). |
| PAYMENT | PASS | cash+change, UPI, mixed, credit (needs customer), shortfall and non-cash overpayment rejected; payments stored net of change; payment report reconciles. |
| PRINT | PASS at HTML/adapter level; real hardware NOT TESTED | All 4 invoice templates + label + report render logo/name/address/phone/GSTIN/invoice no./amounts; failure never rolls back or duplicates a sale; retry from print log. UI "Print A5" went through the real Electron adapter to the virtual "OneNote (Desktop)" printer and reported "Sent to printer". See DEF-6 for preview problem. |
| RETURN | PASS | Partial and full returns, over-return blocked, round-off refunded on full return, return receipt HTML, UI return flow (stock restored, RTN document). |
| REFUND | PASS | refund_cash, refund method cash/original, idempotent return requestId, payments report refunds. |
| REPORT | PASS | payment_methods, sales_summary, gst_rate (per slab after returns + void), profit, stock_valuation all equal hand arithmetic; Reports page total verified in UI; CSV export; dashboard. |
| BACKUP | PASS | API and UI "Back up now" create verified backup; verify OK. |
| RESTORE | PASS (API) | mutate then restore returns table-for-table identical data; requires literal `RESTORE`. The restore wizard UI was NOT driven. |
| OFFLINE | PASS | POS-1 with unreachable server: profile edit, product, sale all work; queue pending > 0; reconnect drains; other POS receives. |
| SYNC | PASS with DEF-5 | profile + logo bytes + product + barcode + stock + sales converge; idempotent on repeat; LWW price edit. |
| MULTI-POS | PASS in-process | Two independent `App` instances/SQLite files through the real HTTP server (distinct invoice series, stock converges). Two real Electron instances on two machines were not tested. |

## 4. The 33-step print test
The product spec list was not available in the repository; the 33 steps below were reconstructed from the brief ("1 create profile, 2 upload logo, ... 33 other POS receives profile") and my reading of the architecture. Verification level: **HTML** = asserted on generated print HTML / DOM; **UI** = driven through the real Electron UI; **adapter** = fake printer adapter; **HW** = physical printer (never possible here).

| # | Step | Result | How verified |
|---|---|---|---|
| 1 | Create shop profile (first setup) | PASS | UI wizard + API; HTML shows name/address/phone/GSTIN |
| 2 | Upload logo | PASS | UI file input, PNG; API |
| 3 | Edit shop name | PASS | API, all 4 templates (HTML); UI preview rename |
| 4 | Edit address | PASS | HTML, 4 templates |
| 5 | Edit phone | PASS | HTML, 4 templates |
| 6 | Edit GSTIN (+ invalid rejected) | PASS | HTML, validation |
| 7 | Edit footer text | PASS | HTML |
| 8 | Logo size/alignment/position settings | PASS | HTML (`width:20mm`), visible on/off |
| 9 | Header toggles (hide address/phone/GSTIN) | PASS | HTML |
| 10 | Preview 58 mm | PASS with DEF-6 | UI preview iframe + HTML |
| 11 | Preview 80 mm | PASS with DEF-6 | UI + HTML |
| 12 | Preview A4 | PASS | UI + HTML |
| 13 | Preview A5 | PASS | UI + HTML |
| 14 | Label with barcode | PASS (HTML) | renderLabelHtml contains barcode and svg/img; label print on paper not tested |
| 15 | Report header (logo + shop) | PASS | HTML |
| 16 | Test print 58/80/A4/label | PASS adapter | fake adapter jobs; failure returned not thrown; UI test-print tab used Preview (dry run) only |
| 17 | Print receipt after sale | PASS | UI Print A5 to virtual printer ("Sent to printer"); adapter for 58/80/A4 |
| 18 | Print failure does not lose/duplicate sale | PASS | adapter fail + throw, sale count unchanged |
| 19 | Retry failed print from log | PASS | retryPrint prints exactly once |
| 20 | Reprint old bill - policy original | PASS | HTML + UI path (sale 1 reprint keeps old name) |
| 21 | Reprint old bill - policy current | PASS | HTML |
| 22 | New sale after rename uses new name | PASS | HTML (Tamil name), UI preview |
| 23 | Very long shop name wraps | PASS (HTML/CSS) | `overflow-wrap:anywhere` present, full name in all templates; visual wrap confirmed in 58 mm preview screenshot; physical wrap on paper not tested |
| 24 | Tamil product and shop name | PASS (HTML) | text intact + Tamil-capable font stack + utf-8 meta; actual glyph rendering on a thermal printer not tested |
| 25 | Replace logo; old bills keep old logo | PASS | HTML byte comparison |
| 26 | Remove logo; old bills keep logo | PASS | HTML |
| 27 | Profile changes audited | PASS | audit_log actions + diffs |
| 28 | Cashier cannot edit profile; manager cannot either | PASS | FORBIDDEN across 12 methods |
| 29 | Backup includes profile + logo | PASS | snapshot equality after restore |
| 30 | Restore brings back profile and logo | PASS | API |
| 31 | Offline profile edit | PASS | dead sync server |
| 32 | Concurrent profile edit conflict | FAIL when edits fall in the same second (DEF-5); PASS when >=1 s apart | two-POS test |
| 33 | Other POS receives profile + logo and prints it | PASS | two-App sync; receipt HTML on POS-2 has name + logo; reprint of remote sale |
| - | Physical printer output (margins, cut, density, font on paper) | NOT TESTED | no hardware |

## 5. Defects
Severity: High = wrong money/behaviour in normal use; Medium = wrong behaviour in plausible use; Low = cosmetic / edge.

### DEF-1 (High) Settings "Selling prices include GST" has no effect
- Repro: Settings > General > Billing > "Selling prices include GST" = No (or `settings.set {key:'billing.prices_include_tax', value:'0'}`), then `pos.cartPrice` / ring a sale: still tax-inclusive (`totals.pricesIncludeTax === true`).
- Cause: `src/main/core/settings.ts:34` defines `billing.prices_include_tax`; `src/main/modules/pos/service.ts:150` reads `pos.prices_include_tax` (also `pos.round_off`, `pos.require_shift` have no Settings entry). Tax-exclusive mode itself works (verified against an oracle by setting the `pos.*` key directly).
- Probe: `edge-cases.test.ts` DEF-1.

### DEF-2 (Medium) Invoice number prefix setting ignored
- Repro: set "Invoice number prefix" to `SLF`; new bill is still `INV-2026-000001`. `src/main/modules/pos/service.ts:164-171` hard-codes `INV`; `billing.invoice_width` (6) and `billing.series_per_pos` also unused. Probe: DEF-2.

### DEF-3 (Medium) Return number prefix setting ignored
- Settings default is `RET` but returns are `RTN-2026-000001` (visible in the UI return dialog and sale detail). Same function. Probe: DEF-3.

### DEF-4 (Low) Cannot search a product whose name contains `%` or `_`
- `src/main/core/lookup.ts:57` and `inventory/util.ts likeTerm` strip wildcard characters from the query rather than escaping them, so typing `100% Pure_Bomb` searches `100 PureBomb` and finds nothing. `pos.search('%')` returns an arbitrary first page (inventory search correctly returns []). Multi-word queries must also be a contiguous substring ("Sparkler 15cm" does not find "Sparkler Box 15cm"). Probe: DEF-4.

### DEF-5 (Medium) Profile edits from two terminals within the same second never converge
- Repro (test): two POS synced; each saves a different shop name without syncing in between and within one second; after unlimited sync rounds POS-1 shows one name and POS-2 the other, and version numbers differ.
- Cause: `business_profile_versions.created_at` has 1-second resolution (default in migration 001 is `strftime('%s','now')*1000`), both versions have the same `version`, and `businessProfile/service.ts` `applySynced` only activates the remote row when `createdAt` is strictly greater (or equal with a higher version), so neither wins. Fix: deterministic final tiebreak on uuid, and use ms timestamps. Probe: `multipos-sync.test.ts` DEF-5. With edits >= 1 s apart convergence is correct (tested).

### DEF-6 (Low/Medium) Printing preview of receipts is not WYSIWYG
- Repro: Printing & Labels > Templates, 58 mm or 80 mm. The preview iframe shows an inner vertical scrollbar (and for 58 mm a horizontal one); the iframe's usable width shrinks by ~15 px (measured: 58 mm preview `scrollWidth 219 / clientWidth 204`), so text wraps earlier than the real print and content touches the scrollbar. A4/A5 are fine. See `docs/qa-screens/13-printing-templates.png`, `13b-printing-preview-80.png`.
- Suspected: `src/renderer/modules/printing/PrintPreview.tsx` height measurement equals content height exactly, producing an unnecessary scrollbar (needs `scrolling="no"`/overflow hidden or +1 px).

### DEF-7 (Low) Open-shift dialog pops over a half-built bill
- On every entry to Billing with no shift open, "Open cash shift" appears about 1-2 s after the page loads, even after a scan has started (it stole focus/blocked clicks in the E2E run until "Skip for now" was pressed). `src/renderer/modules/pos/PosScreen.tsx` (shift dialog effect). Setting `pos.require_shift` is off, so the prompt is optional but intrusive.

### DEF-8 (Low) Layout nits at 1366x768 (screens)
- Products page: search, category, brand and status filters each take a full-width row (wasting about 200 px), and the page title duplicates under the tab buttons (`31-1366-products.png`). `ProductsTab.tsx`.
- Sidebar at 1366x768 does not fit all items; Settings/Users/Backup need sidebar scrolling.
- Dashboard shows "11 changes waiting to sync" with sync never configured (informational, can alarm a single-PC shop).
- Product form modal keeps the page's "Generate missing barcodes" button in the accessibility tree (button names collide; modal does not make the background inert).

### Observations (not defects)
- Setup wizard sends `pos`/`locationName` always; `setup.complete` called without them fails with a raw zod message (UI always sends them).
- `completeSale` with the same `requestId` but a different cart returns the ORIGINAL sale (idempotency key wins) - acceptable but callers must not reuse ids.
- Quantities are capped at 1,000,000 per line; a 900,000-unit line stays exact (BigInt oracle equal).

## 6. Performance (measured, 20,000-product catalog, in-process)
scan by barcode 2.6 ms; name search 30 ms; SKU search 43 ms; `catalog.list` search 82 ms; search matching all 20k rows (limit 30) 24 ms. Seeding 20k products via SQL took 18.6 s (test setup, not an app path).

## 7. Honest limitations
- No physical printer, scanner, cash drawer or thermal paper: margins, cutting, density, Tamil glyphs on a thermal head, barcode scannability of printed labels are untested. "Print" proven to the adapter/HTML level and to one virtual Windows printer.
- INSTALL (installer build/uninstall/upgrade) not tested; app was launched from the built `out/` folder, not a packaged exe.
- Not driven through the UI: product Import wizard, Backup restore wizard, Sync settings panel, Users/Roles editing, Purchases, Stock counts/transfers, Labels printing, report Excel/PDF export, held bills, shifts, discounts/approval dialog in the UI (approval logic covered by API tests).
- Multi-POS used two in-process `App` instances sharing the reference HTTP server, not two Electron apps or a real network; no latency/partition fault injection beyond a dead server.
- The 33-step list was reconstructed (spec not found in repo).
- Only Windows 11 at 125 % scaling and sizes 1024/1366/1920 were checked; no screen reader / keyboard-only audit, no dark theme pass.
- Timing-based perf thresholds in existing tests can fail under CPU contention (see section 2).


---

## Addendum - post-QA fixes and installer (integrator)

**Defects DEF-1 to DEF-8 were fixed** (settings key unification, invoice/return prefixes, deterministic profile-conflict tiebreak, preview width, shift dialog, LIKE escaping, layout/a11y). The five probe tests that failed during QA now pass unchanged.

**Additional changes requested by the owner after QA:** beep on item add / product save and an error buzz on not-found; old barcodes keep working after any price change (covered by tests/integration/price-barcode.test.ts); A5 invoice button at POS; EAN-13 generation validated for validity, uniqueness and jsbarcode rendering.

**Final gate (integrator run):** typecheck clean; vitest 534 passed, 1 skipped (Electron layout test is opt-in), 2 timing assertions (catalog 5,000-row import, reports 50k-sale dashboard) failed only when the whole suite ran in parallel and pass when run alone; build OK; Playwright UI suite 12/12 on the built app.

**Installer:** release/Velmayil POS Setup 1.0.0.exe (NSIS, x64, ~117 MB), unsigned. The packaged app (release/win-unpacked) was launched with a fresh data directory: first-run setup screen rendered, migrations ran, SQLite DB created, IPC responded. See tests/e2e/packaged-smoke.mjs.

**Still NOT verified (honest limits):** running the NSIS installer itself (install / uninstall / upgrade) on a clean machine; printing on physical 58mm/80mm/A4/A5/label printers (verified to HTML, PDF and the Windows print spooler only); JPEG/WebP/SVG logos through the UI; two real Electron instances syncing; the installer is not code-signed, so Windows SmartScreen will warn.

---

## Barcode scanner (owner reported "scanner not working / not detected")

**What the evidence says about the owner's PC.** Windows reports no barcode reader at all: the USB device that used to appear on that port (a `VID_0483&PID_0011` HID keyboard, the typical cheap reader) now fails with "Device Descriptor Request Failed" (problem code 43). When Windows cannot enumerate the device no application can receive anything from it, so that part is a hardware problem (port, cable or the reader itself) and no software change can fix it. Settings > Scanner now shows this verdict in plain words (it asks Windows through `Win32_PnPEntity`), next to the list of USB/HID/serial devices the app can see. On this test PC the panel reports "Windows lists no device that looks like a barcode reader".

**Software root causes found and fixed** (each was reproduced with OS-level key injection, see below):
1. *A reader's second terminator pressed Pay.* CR+LF readers (Enter, Enter) made the empty-box Enter open the payment dialog, and the box still held the old code while the 2nd Enter arrived, so the item was added twice. The box is now emptied immediately and a 350 ms "stray terminator" guard (also for Ctrl+J) swallows the second key.
2. *A scan while a dialog was open could press its focused button.* With "Cancel this bill?" open, the reader's Enter hit "Clear bill". Scans are now recognised and swallowed while a dialog is open (text fields in the dialog are left alone); on "Sale completed" a scan starts the next bill with that item.
3. *Alt+numpad "Alt-code" readers* were impossible: the shell's `alt+1..9` navigation hotkeys fired on the numpad digits (the app jumped to other pages) and cancelled the composed character. Fixed in `ui/hooks.tsx`; the character (it arrives with `keypress`/`input` only, key event code `AltLeft`) is read through a keypress path.
4. *Slow readers (Bluetooth, 50-100+ ms per key) only worked by luck.* The scan box (always focused on the billing screen) now owns Enter/Tab with ANY timing; the global capture is the fallback for other focus (body, bill note, ...) and is generous (250 ms) when nothing editable has focus. The limit adapts to the reader (rolling median of its slowest gaps, never stricter than the configured value).
5. *Hidden coupling of the Tab suffix:* Tab readers tabbed out of the box; default suffix is now "Enter or Tab".
6. *Layout and key-name problems:* `Unidentified`/IME `Process` keys, Tamil/Hindi layout output (letters in another script, even several code points per key), AZERTY/Shift-latched digit rows, Caps Lock, NumLock off (numpad keys arrive as End/ArrowDown...) are normalised from the physical key (`e.code`), in the global detector and in the scan box (box repair only for machine-speed input, so people typing Tamil product names are not touched). A lone real symbol (`AB#`) is no longer "repaired" into a digit.
7. *Leaks:* the first character of a burst is removed again from text, number, textarea, contenteditable and select targets; a held key (auto-repeat) cancels a burst and gives back the swallowed keys.
8. *Lookup:* every scanner consumer now uses one tolerant lookup (`app.lookup.byScan`): POS, stock-count scan, inventory lookup/product pickers and the catalog resolver. Added UPC-E 6/7-digit forms, GTIN-14 with a real indicator digit (check digit recomputed), C1/zero-width characters; search boxes ignore `]E0`, stars and CR/LF framing; the Products form and spreadsheet strip decorations before saving a barcode and a scan REPLACES the old barcode text.
9. *Not-found diagnosis:* a persistent red message on the billing screen shows the exact scanned code (control characters spelled out, e.g. `<CR>`), plus a header indicator "Scanner: last scan 12:01:05 (8901234567, 3 ms/key)".

**New:** Settings > Scanner "Detect my reader" wizard (records every raw key, computes per-key gap, ending key, prefix, layout/Caps/NumLock/Alt-code findings and saves the settings, with Undo), a connected-devices panel with Windows verdict, a four-case troubleshooting checklist, optional WebHID (HID POS, usage page 0x8C, plus vendor mode chosen by hand) next to the existing serial support. Main-process device access is one module (`deviceAccess.ts`): a single `setDevicePermissionHandler` for serial+HID and one `select-serial-port`/`select-hid-device` chooser, so handlers cannot overwrite each other.

**Verified at OS-input level** (`tests/e2e/scanner-os.spec.ts`, built app, real Windows `SendInput` through `tests/e2e/tools/sendkeys.ps1`; the injector refuses to type unless the launched app owns the foreground window; falls back to CDP `Input.dispatchKeyEvent` rawKeyDown+char+keyUp, which also passes: `SCAN_E2E_MODE=cdp`): inter-key gaps 1/5/20/50/90 ms; Enter, Tab, CR+LF, Ctrl+J, no suffix (pause); prefix Tab key, prefix `~`, prefix + suffix; upper case, Caps Lock ON/OFF, Shift latched, Shift+digit-row symbols, lower case; numpad scan codes with NumLock ON and OFF; Unicode (VK_PACKET) packets; Alt+numpad codes; 30-character, 4-digit and leading-zero codes; repeated scans 50 ms apart; auto-repeat of a held key; focus on the scan box, body, bill note, number input, textarea, contenteditable, select, Products form barcode field, spreadsheet cell, stock-count box, purchase picker, label search; toast showing; "Cancel this bill?" and "Sale completed" dialogs; the wizard with a Tab-suffix, a CR+LF + Caps Lock + 70 ms reader; unknown code message and indicator. Each case asserts exactly one cart add, the right quantity, no double add and no characters left in any field. Pure logic (detector, wizard analysis, adaptive timing, box repair, HID report parsing, Windows device classification) is covered in `tests/scanner/*.test.ts`; lookup variants in `tests/pos/scan-pay.test.ts`.

**Results of the final gate for this work:** typecheck clean; vitest 689 passed / 3 skipped (45 of them scanner unit tests, the extended `scan-pay` lookup tests included), the two known timing tests (`tests/catalog/perf`, `tests/reports/perf`) fail only in the parallel full run and pass alone (3/3); build OK; Playwright on the built app 50/50 (app 13, grid 4, pos-pay 9, scanner-os 24, real SendInput injection mode). Two regressions were caught by the old e2e suite and fixed on the way: a person's last typed character could be glued onto the front of the next scan (the relaxed 250 ms gap is now decided by where the burst STARTED, and a key on a different element breaks the burst), and the tail of a scan that stalled midway could be accepted as a code of its own (now refused).

**NOT verified (needs the owner's physical reader):** that the owner's model types as a keyboard (or which mode it is in); real inter-key timing and suffix of that unit; WebHID report layout of any real HID-POS reader (parser follows the common length/symbology/data layout with a printable-ASCII fallback, unit-tested with synthetic reports only; multi-report codes use the usual "more data" flag); Web Serial against a real COM-port reader; Bluetooth pairing/latency; reader-specific programming barcodes (the checklist names the usual "USB HID keyboard" barcode per vendor but model-specific pages were not checked); non-US Windows keyboard layouts were simulated with synthetic key events (Tamil/Hindi layouts are not installed here) rather than a live layout switch. The SendInput tests use a US layout on this PC.

---

## Addendum 2 - performance handoffs and rebuilt installer (final integrator)

**Changes:** exceljs (catalog import/export) is loaded on first use via `await import()`; jsbarcode and qrcode load on first barcode/QR render (lazy `createRequire`, still external in the main bundle), keeping ~0.5 s of `require` out of startup. The POS, Products and Printing routes are `React.lazy` (new `CatalogPage.tsx`, `PrintingPage.tsx`; the main chunk shrank from 1,167 kB to 838 kB). `app.enqueueSync` no longer queues rows unless `sync.enabled='1'` or sync was ever bootstrapped (`sync_state.bootstrapped`); `resyncAll` bypasses that gate, so enabling sync later still sends everything (seam test `tests/seams/sync-off-queue.test.ts`: sales made while sync is off arrive on the second POS after enabling; disabling again after a bootstrap keeps queueing). Test helpers pre-mark sync as bootstrapped so queue-asserting tests keep their meaning; the sync harness opts out. `catalog.list` skips COUNT on a non-full first page; `pos.listSales` pages first, computes item_count/returned_total only for page rows and skips COUNT on a non-full first page. Inventory stock, low-stock, purchases and suppliers lists now live-refresh (`useLiveRefresh`). The Printing page already renders only the active tab.

**Honest limits:** no real barcode scanner or receipt/label printer hardware was available; the serial (Web Serial) scanner path and raw ESC/POS output remain unverified on devices. The installer itself was not run (install/uninstall/upgrade untested) and is unsigned (SmartScreen warns); only the unpacked packaged app was smoke-tested. Code-like catalog search terms still use the contains-scan (index range lookups were not applied because they would change which products match). Existing `pending` queue rows from earlier versions are not purged on upgrade.
