import type { Migration } from '../migrate'

/** Agent 7 (users/security): forced password change, password timestamp. */
export const migration: Migration = {
  version: 600,
  name: 'auth_security',
  sql: `
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- audit_log append-only triggers live in 002_integrity (trg_audit_log_no_update / _no_delete)
`
}
