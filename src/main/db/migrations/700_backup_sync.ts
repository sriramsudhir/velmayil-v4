import type { Migration } from '../migrate'

const NOW = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

/** Agent 8 (backup / sync, range 700-799). Additive only. */
export const migration: Migration = {
  version: 700,
  name: 'backup_sync',
  sql: `
-- ---------- backup ----------
ALTER TABLE backups ADD COLUMN schema_version INTEGER;
ALTER TABLE backups ADD COLUMN manifest_json TEXT;
ALTER TABLE backups ADD COLUMN verified_at INTEGER;
ALTER TABLE backups ADD COLUMN note TEXT;

-- ---------- sync ----------
-- exponential backoff: the item is not retried before this time
ALTER TABLE sync_queue ADD COLUMN next_attempt_at INTEGER;

-- every inbound change that lost / collided / could not be applied cleanly (shown in the Backup & Sync page)
CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT ${NOW},
  kind TEXT NOT NULL,            -- lww_lost_remote | lww_lost_local | duplicate_key | number_collision | apply_error | unresolved_ref | version_collision
  entity TEXT NOT NULL, entity_uuid TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  local_json TEXT, remote_json TEXT,
  resolution TEXT NOT NULL DEFAULT '',
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_conflicts_ack ON sync_conflicts(acknowledged, id);

-- idempotency: (origin device, origin queue id) already applied here
CREATE TABLE sync_inbox (
  device TEXT NOT NULL, qid INTEGER NOT NULL, applied_at INTEGER NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (device, qid)
);

-- inbound changes waiting for a referenced row from another terminal (ordering across devices is not guaranteed)
CREATE TABLE sync_deferred (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL, qid INTEGER NOT NULL, change_json TEXT NOT NULL,
  missing TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL DEFAULT ${NOW},
  UNIQUE (device, qid)
);

-- a remote row that is the "same" thing as a local row with a different uuid (e.g. same category name created offline on two POS)
CREATE TABLE sync_aliases (
  alias_uuid TEXT PRIMARY KEY, table_name TEXT NOT NULL, local_id INTEGER NOT NULL
);

-- terminals we have heard from
CREATE TABLE sync_devices (
  device TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL DEFAULT ${NOW}, last_seen INTEGER NOT NULL DEFAULT ${NOW},
  last_qid INTEGER NOT NULL DEFAULT 0, changes_in INTEGER NOT NULL DEFAULT 0
);
`
}
