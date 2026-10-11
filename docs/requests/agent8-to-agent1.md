# Agent 8 (Backup / Sync) -> Agent 1 (Core) requests

None of these block Agent 8; everything below already works today with the documented workaround.

## 1. Optional: `app.reopenDb()` (restore without ATTACH)
`App.db` is `readonly` and holds one open `node:sqlite` connection. Agent 8's `backup.restore()` therefore swaps data
**in place**: copy the .vbak to a private work file -> verify (sha256, integrity_check, foreign_key_check, row counts)
-> safety backup of the live DB -> `ATTACH` the work copy -> inside ONE transaction drop the append-only/immutability
triggers, `DELETE`+`INSERT … SELECT` every table (except `backups`, `schema_migrations`), restore `sqlite_sequence`,
recreate the triggers, `PRAGMA foreign_key_check`, audit -> commit (any failure = full rollback) -> `DETACH`.
This is correct but it has to temporarily drop triggers (DDL inside the transaction, rolled back on error).
If you would rather have a close / replace-file / reopen swap, expose on `App`:
`reopenDb(): void` (close `db`, reopen same path, re-run migrations; make `db` a getter). Then `restore()` could
simply replace the file. Not required.

## 2. Hook order on `app.close()`
`backup` and `sync` wrap `app.close` on the instance (`backup` can take an optional "backup on exit"; both stop their
timers first). Please keep `close()` a normal overridable method, or add `app.onClose(fn)` and tell me to switch.

## 3. Settings keys used (read/written with `app.setting` / `app.setSetting`)
`backup.auto_enabled` (1) · `backup.interval_hours` (24) · `backup.retention` (14) · `backup.folder` (default `<userData>/backups`) ·
`backup.copy_folder` · `backup.on_close` (0) · `backup.last_error` · `sync.enabled` (0) · `sync.transport` (`http`|`folder`) ·
`sync.url` · `sync.folder` · `sync.key` (secret; the settings UI should mask/hide it) · `sync.interval` (60 s).
If the Settings page lists settings generically, hide `sync.key` and `backup.last_error`.

## 4. Users are not synced
Sales reference `users`. Credentials never leave a terminal, so a remote `user_id` is materialised as an **inactive stub user**
(`remote-<uuid8>`, name `Remote user (<POS code>)`, lowest-privilege role, password `disabled:remote`). Reports that show a
cashier name for remote sales will show that label. If you want real names, add a `users` snapshot that carries only
`uuid, username, name` (no hashes) and tell me; the apply handler for it is a 10-line addition.

## 5. Observed while integrating (FYI, already resolved by others)
`002_integrity` and `100_pos` both created `idx_sales_shift` / `idx_sales_customer`; this briefly broke every `createTestApp()`.
