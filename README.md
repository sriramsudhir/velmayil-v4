# Velmayil POS

Offline-first Windows desktop point-of-sale for retail / fireworks shops.
Electron + TypeScript + React + built-in SQLite (`node:sqlite`, no native modules).

## Features
POS billing (cash / UPI / card / split, change calculation), barcode scanners (USB/Bluetooth/serial), product catalog with
Excel-style grid editing, barcode + label generation (many sizes), inventory & purchases, reports (GST, profit, payments),
versioned shop profile with logo used on 58mm/80mm receipts, A4/A5 invoices, labels and reports, users/roles/approvals,
audit log, backup/restore, optional multi-POS sync.

## Develop
```
npm install
npm run dev          # run the app
npm run typecheck
npm test             # unit + integration (vitest)
npx playwright test -c tests/e2e/playwright.config.ts   # UI tests on the built app (run `npm run build` first)
npm run dist         # Windows installer -> release/
```
Note: if `ELECTRON_RUN_AS_NODE` is set in your shell, unset it before launching Electron.

## Docs
- `ARCHITECTURE.md` - module layout, rules and cross-module contracts
- `docs/QA_REPORT.md` - QA results and honest limitations
- `docs/PERF_REPORT.md` - performance work
