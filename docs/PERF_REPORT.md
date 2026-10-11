# Velmayil POS - Performance report

Complaint: "there is some lag in the application". This report records what was measured, what was found, what was fixed and what is left for the other owners.

## How it was measured (repeatable)

| What | Script |
|---|---|
| Realistic dataset: 20,000 products (22,000 variants), 50,000 sales (~160k lines, 90 days), 5,000 customers, 62k stock movements, 20k audit rows, 30k sync-queue rows, 83 MB DB. Uses the real migrations, module registration and the real `setup.complete` service. | `tests/perf/seed.ts` (CLI wrapper `tests/perf/seed.cli.test.ts`: `PERF_SEED_DIR=<dir> npm test -- tests/perf/seed.cli.test.ts`). Login: `owner` / `perf-pass-1`. |
| BUILT app via Playwright `_electron`: startup, per-page render time (DOM-settle), renderer long tasks (PerformanceObserver), main-process event-loop lag (10 ms sampler inside the main process), IPC round trip + payload size of every list/get/summary method, idle polling (65 s), a manual backup with a concurrent probe call. | `node tests/perf/measure.mjs <seeded-dir> [out.json]` |
| Cold-start A/B and where main-process startup goes. | `tests/perf/startup.mjs`, `tests/perf/startup-trace.mjs` |
| Regression guards (run in `npm test`). | `tests/perf/perf.test.ts`, `tests/perf/ui-perf.test.ts` |

Caveat on the numbers: the machine was shared with two other agents running builds/tests/Electron at the same time, so wall-clock values move by 2-3x between runs. The "after" column is the best of several runs; the "before" column is the first clean baseline. The *work done* (statements, payload bytes, blocked-loop time) is deterministic and is what the guard tests assert.

## Top findings (in order of how much a cashier would feel them)

1. **Automatic backup froze the whole app for 6-8 seconds**, 10 s after every start (first run) and then every interval. `VACUUM INTO`, schema/row counts, SHA-256 (twice), `integrity_check`, `foreign_key_check` and the second copy all ran synchronously on the main process (node:sqlite is synchronous), so no IPC call, click, scan or sale was answered meanwhile. Measured: a trivial `auth.current` issued during a manual backup took **8,098 ms**.
2. **Dashboard** `dashboard.summary` took 250-370 ms on every open and every 60 s refresh (and on every window focus). The 30-day item/payment/heat aggregates over ~16k bills were recomputed each time, plus a 160 ms cold low-stock query.
3. **Reports** sent the *entire* result over IPC (4-4.8 MB / 20,000 rows for sales detail, item sales, tax register, stock valuation, stock ledger) and the renderer sorted/sliced it; the SQL itself re-ran on every sort/page/export. The shared "lines" CTE joined variants+products for each of ~48k lines (3-5x the rest of the query).
4. **Inventory**: every Stock page (and every page turn) ran COUNT + SUM over the whole 22k-variant catalogue (85-120 ms); `valuation` 250 ms, `verifyLedger` 415 ms and a 2 MB payload, `lowStockCount` 63 ms, low-stock page rendered 500 rows (4,500 DOM nodes, 154 ms long task); a full-catalogue stock count sheet fetched and rendered up to 5,000 rows, and refetched all of them on every scan.
5. **Product search** (POS search box, inventory pickers, labels; `core/lookup.ts`) 40-50 ms per keystroke: scan + sort of all variants.
6. **Polling**: top-bar sync status polled a method that does not exist (`sync.status`, always failing, every 30 s, and the pill never showed pending/Synced); idle-lock polled every 10 s and re-rendered every time; dashboard/sync panel polled while the window was hidden and could overlap; shell re-fetched shop identity (+ logo) on every window focus.
7. **Startup**: `exceljs` (463 ms), `zod` (95 ms), `jsbarcode`+`qrcode` (75 ms) are `require`d at the top of the main bundle before the window exists. DB open + migrations check = 22 ms, module registration 5 ms, settings 1 ms (all fine). Not in my area - see Handoff.
8. **Bundle**: one 1.17 MB renderer chunk loaded and parsed before the login screen.

## Fixes (all in files I own)

| Area | Change |
|---|---|
| Backup | `backup/snapshotWorker.ts`: the whole file pipeline (VACUUM INTO via its own read-only WAL connection, counts, SHA-256, integrity + FK check, rename, manifest, second copy) runs in a worker thread (self-contained CommonJS string, so it works in the electron-vite bundle, dev and vitest with no build change). `BackupService.createAsync()` / `runIfDueAsync()`; the scheduler and the `backup.create` / `backup.runDue` IPC methods use them; only the small `backups` INSERT + audit runs on the main thread. Sync `create()`/`runIfDue()` kept for restore's safety backup, quit-time backup and tests. |
| DB pragmas | `db/driver.ts`: `cache_size=-65536` (64 MB), `temp_store=MEMORY`, `mmap_size=256 MB`, `journal_size_limit=64 MB` (bounded WAL). No durability change. |
| Dashboard | `reports/dashboard.ts`: the 30-day history is built once per day and cached (`reports/cache.ts`), guarded by an index-only fingerprint (bill count in the window, void count/last void, last return id). Only *today* is queried live and merged, so a sale made a second ago still shows and voiding an old sale invalidates the cache. Top products/category share use a per-variant fold plus a sorted leader list (no 16k-entry merge). The cold build is a generator sliced per day and `summaryAsync` yields to the event loop between slices; `auth.login` pre-warms it in the background so the first dashboard paint is instant. Low-stock count uses a partial index and a stock stamp cache (`inventory/lowstock.ts`). Gross profit uses a lean `linesCte` (no joins). |
| Reports | Result cache keyed by report + filters + day + profit permission, invalidated by any write (`total_changes()`), 2 min max. New `reports.runPage` (server-side sort + 200-row pages; `ReportsPage` uses it: 4 MB -> 24-60 KB per page, sorting/paging never re-runs SQL). `linesCte(from,to,needs)` skips the variant/product joins unless the report uses `product_id`/`unit` (category/brand fall back lazily): category/brand/profit/GST-rate reports 3-5x faster. |
| Inventory | `stock()` totals computed once per filter and cached; narrow totals query (no category join, text columns only when searching); `valuation` rewritten (per-variant stock first, then one join); `verifyLedger` is one grouped pass and returns at most 500 mismatches; `lowStockCount` cached; `countGet` is paginated (default 200, `total` for the pager) and the count sheet UI pages 100 at a time; `Table` renders the first 100 rows progressively ("Show more"); `DataTable` auto-pages above 300 rows. |
| Product search | `core/lookup.ts` `searchVariants`: ordered by the NOCASE name index so SQLite stops at the limit for ordinary words (code-like terms keep the plain scan). |
| Polling | `useInterval` (ui/hooks): paused while the window is hidden, never overlaps an in-flight run, refreshes on return only if stale. Top bar uses the new cheap `sync.badge` (any signed-in user, no counting when sync is off; fixes the dead `sync.status` call); 60 s, state kept identical when nothing changed. Idle-lock poll 20 s, hidden-aware, no re-render when unchanged, heartbeat 30 s. Shop identity re-read on focus at most once a minute. SyncPanel uses `useInterval` (10 s). |
| Code splitting | Route components of dashboard, reports, inventory (10 pages), settings, backup, users, business profile are `React.lazy` (dashboard/backup/users/settings index split into thin `index.tsx` + `*Page.tsx`). Shell already has `Suspense`. |
| Indexes (migration 800, additive) | `idx_sales_voided` (partial), `idx_variants_reorder` (partial). Existing 400/401 covering indexes confirmed in use by the plan guard tests. |

## Before / after

Dataset above, built app, IPC round trip as seen by the renderer unless noted. "cold" = first call after launch or after a write that invalidates the cache.

| Measure | Before | After |
|---|---|---|
| Main process blocked by backup (80 MB DB) | **8,141 ms** (also 6.1 s 10 s after start) | **11-25 ms** max loop lag; probe call latency 8,098 ms -> 1-2 ms |
| `dashboard.summary` (IPC) | 253-371 ms every call | **15-40 ms** warm (10-14 ms in-process); cold build sliced into ~ms steps and pre-warmed at login |
| `dashboard` page time-to-settled | 439 ms (414 ms loop block) | 45-120 ms |
| `inventory.stock` page 1 / next page | 122 ms / 122 ms | cold 60-160 ms once, then **2-10 ms** |
| `inventory.stock {search}` | 82 ms | 8-18 ms (cold 40-120) |
| `inventory.valuation` | 247 ms | 25-50 ms (cached) |
| `inventory.verifyLedger` | 415 ms, 2,021 KB | 105 ms (in-process), 45 KB |
| `inventory.lowStock` / `lowStockCount` | 203 ms / 63 ms | 20-45 ms / 1 ms (20 ms cold) |
| `/inventory/low-stock` page | 393 ms, 154 ms long task, 4,518 nodes | 122-160 ms, no long task, 921 nodes |
| `pos.search` / `inventory.search` | 40-50 ms / 31-39 ms | **5-6 ms** |
| `reports.run` cold: category / brand / profit / gst_rate / gst_hsn | 555 / 535 / 639 / 556 / 607 ms | 97-195 / ~100-260 / 107-300 / 73-166 / 162-318 ms |
| `reports.run` cold: item_sales / sales_detail / tax_register / stock_valuation | 911 / 479 / 551 / 311 ms | 330 / 300 / 400 / 230 ms (first run only; cached afterwards) |
| Report payload per screen | 2.7-4.8 MB (20k rows) | **24-60 KB** (`runPage`, 200 rows) |
| Report re-sort / page / export of same result | full SQL again (0.3-0.9 s) | 1-3 ms |
| Idle IPC calls in 65 s | dashboard 2, auth.current 6, sync.status 2 (failing), touch 2 | dashboard 1, auth.current 3, sync.badge 1 |
| Polling while window hidden | continues | none |
| Renderer long tasks (>50 ms) | 154 ms (low stock), 54 ms (reports) | none >70 ms |
| Count sheet (22k lines) | up to 5,000 rows fetched + rendered, refetched per scan | 100 rows per page |
| Renderer initial JS | 1,227 kB single chunk | 1,167 kB + 12 lazy chunks (dashboard 12, reports 28, inventory 5 files ~70, settings 32, backup 29, users 25, shop 22 kB). pos/catalog/printing still eager (Handoff). |
| First paint (FCP) / login -> shell | 372 ms / 1.0 s | 150-390 ms / 0.34-0.95 s (machine-load dependent) |
| Main-process startup work (open + migrations + modules + settings) | 28 ms | 28 ms (module `require`s: see Handoff) |

Targets: pages < 300 ms - met except the *first* run of the heaviest reports (item_sales, tax_register, sales_detail ~ 300-480 ms cold on 50k sales, cached after) and `/printing` (330-420 ms, not my module). Service calls < 50 ms - met for everything on the hot paths (dashboard, stock, search, lists); exceptions are cold first calls of stock/valuation (up to ~150 ms once), explicit health check `verifyLedger` (105 ms), heavy first-run reports, and the catalog/pos items below. Main-thread blocking > 50 ms: backup gone; remaining one-offs are heavy first-run reports, `verifyLedger`, `auth.login` (scrypt, 62 ms), first-time `sync` enable (`resyncAll`, single transaction over all tables). Typing/scrolling: no long task over 100 ms observed. Shell first paint < 1 s: met.

## Regression guards (`tests/perf`)

* `perf.test.ts` (6,000-sale seeded DB, ~20 s): query plans use `idx_sales_voided` / covering sales+item indexes / `idx_variants_reorder` / `idx_products_name` / `idx_sync_status` (no scans on big tables); warm dashboard runs no 30-day item/payment aggregation, gives identical figures from the cache, still shows a sale made after the cache was built and a void of an old sale; the cold build yields to the event loop; same report twice runs its SQL once, a write invalidates it, `runPage` returns one sorted page <= 1/4 of the full payload; stock totals computed once per filter; count sheet paged; `verifyLedger` capped; `sync.badge` does not touch the queue when sync is off; `createAsync` on a ~50 MB database leaves no event-loop gap near the backup duration and produces a verified manifest; `runIfDueAsync` never overlaps. Wall-clock assertions are generous (dashboard warm best-of-5 < 80 ms; loop gap < max(300 ms, duration/2)).
* `ui-perf.test.ts`: `Table` mounts <= 100 rows then "Show more", `DataTable` auto-pages, `useInterval` is silent while hidden, never overlaps, refreshes only when stale.

## Handoff (other owners; I did not edit these)

1. **Main startup: lazy-load `exceljs`** (`src/main/modules/catalog/io.ts`). The top-level `import ExcelJS from 'exceljs'` costs ~460 ms of synchronous `require` before the window exists (A/B, same machine: login form 4.43 s -> 3.77 s). Both users are already `async`:
   ```ts
   // remove: import ExcelJS from 'exceljs'
   const loadExcel = async () => (await import('exceljs')).default
   export async function parseXlsx(bytes: Buffer) { const ExcelJS = await loadExcel(); const wb = new ExcelJS.Workbook(); ... }
   export async function toXlsx(...) { const ExcelJS = await loadExcel(); ... }
   ```
   (`reports/export.ts` already imports it lazily.) Same idea for `jsbarcode` / `qrcode` (~75 ms) in the printing/pos barcode code: `await import()` inside the renderer-HTML builders.
2. **Renderer bundle: lazy routes for pos, catalog, printing** (`modules/{pos,catalog,printing}/index.tsx`, ~215 kB of source, pulls `jsbarcode` into the first chunk). Pattern (see `modules/inventory/index.tsx`):
   ```tsx
   import { lazy } from 'react'
   const PosPage = lazy(() => import('./PosScreen').then((m) => ({ default: m.PosPage })))
   ```
   Keep `PrintPreview` re-export from printing/index.tsx in a separate small file if other modules import it eagerly.
3. **`sync_queue` grows ~3.4 KB per sale forever while sync is off** (measured: one 5-line sale = one 3,445-byte `sales` snapshot; 50k sales ~ 170 MB of queue in the DB, which also makes every backup/VACUUM/restore slower). `app.enqueueSync` (core/app.ts) inserts unconditionally; rows only become `sent` when a sync cycle runs. `resyncAll` already re-enqueues everything the first time sync is enabled, so the rows are redundant until then. Suggested: in `enqueueSync`, return early unless `settings.sync.enabled = '1'` OR `sync_state.bootstrapped = '1'` (one cached boolean, refreshed when sync config is saved). Also drop already-queued `pending` rows once on upgrade if never bootstrapped.
4. **`catalog.list` with search** (catalog/service.ts `list` + `buildWhere`): 22-35 ms for words, **110-140 ms for code-like terms** (barcode/SKU fragment): the `OR p.id IN (SELECT ... LIKE '%x%' UNION ...)` is evaluated twice (COUNT and page). Fixes: skip the COUNT when `offset === 0 && rows.length < limit` (total = rows.length); for terms with a digit and no space use index ranges (`barcode >= ? AND barcode < ?`, `sku COLLATE NOCASE >= ?`, alias `barcode` PK) before the contains-scan; or memoize with `StampCache` + `dataStamp` from `src/main/modules/reports/cache.ts` (same pattern as `inventory.stock`).
5. **`pos.listSales`** (pos/service.ts): `OFFSET 20000` = 74 ms and `search` = 120-140 ms. Page first, then compute `item_count`/`returned_total` only for those rows (`WITH page AS (SELECT ... ORDER BY s.id DESC LIMIT ? OFFSET ?) SELECT page.*, (SELECT COUNT(*)...)`), use keyset paging (`s.id < ?`) for "next", and make invoice search a prefix/range on the UNIQUE `invoice_no` index and customer search a prefix on `idx_customers_name`/`idx_customers_phone` instead of `LIKE '%q%'` across a join with `OR`. Skip `COUNT(*)` when the first page is not full.
6. **`/printing` page 330-420 ms to settle** (renderer/modules/printing): `TemplatesTab` mounts the preview iframe and `listTemplates` (10 KB) together; consider rendering the iframe after first paint (`requestIdleCallback`) and only the active tab's data.
7. **`Db` has no prepared-statement cache** (`db/driver.ts` `all/get/value/run` call `prepare()` every time). Only worth doing if profiling shows prepare in the profile (it is < 0.3 ms per call today); an LRU `Map<string, StatementSync>` (~200 entries, cleared on `close()`) is the change. Outside the "pragmas only" allowance, so not done.
8. `auth.login` / PIN unlock / approvals use `scryptSync` (62 ms of blocked main thread per sign-in). Acceptable today; if it ever matters, `crypto.scrypt` (async, libuv pool) would need the lockout accounting made async-safe, which I did not risk.
9. `core/app.ts` change watcher emits `{service:'sync'}` ("refresh everything") for *any* write not made through `App.call` (backup bookkeeping rows, sync collector, timers). Fine today because those are rare; keep background jobs from writing on a short timer.

## Not changed on purpose

* Heavy reports are still computed on the main thread (first run only, then cached): a worker would need the report builders compiled into a second bundle entry (build config change). The paged IPC and cache remove the repeat cost and the 4 MB payloads.
* `verifyLedger` is an explicit integrity check, not called by any screen; it is now one pass and bounded in output.
