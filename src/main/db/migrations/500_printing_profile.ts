import type { Migration } from '../migrate'

/**
 * Agent 6 (printing / business profile) additive schema.
 *  - business_profile_versions.logo_sha256 : portable reference to the logo (logo bytes sync as their own entity)
 *  - print_log                             : recent print attempts (failures keep their HTML so they can be retried)
 */
export const migration: Migration = {
  version: 500,
  name: 'printing_profile',
  sql: `
ALTER TABLE business_profile_versions ADD COLUMN logo_sha256 TEXT NOT NULL DEFAULT '';
UPDATE business_profile_versions SET logo_sha256 = COALESCE((SELECT sha256 FROM logo_assets WHERE logo_assets.id = business_profile_versions.logo_asset_id), '');
CREATE INDEX idx_logo_assets_sha ON logo_assets(sha256);

CREATE TABLE print_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  paper TEXT NOT NULL DEFAULT '',
  printer TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  action TEXT NOT NULL DEFAULT 'print',
  doc_ref TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  html TEXT
);
CREATE INDEX idx_print_log_ts ON print_log(ts);
`
}
