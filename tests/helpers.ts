import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/main/core/app'
import { registerAllModules } from '../src/main/core/modules'
import { DEFAULT_ROLES } from '../src/shared/permissions'

/**
 * Test app with real migrations + all registered modules and a minimal seed (roles, admin, POS-01, default
 * location, initial shop profile v1) so module tests don't depend on the setup wizard. Signed in as Owner.
 */
export function createTestApp(opts: { modules?: boolean; seed?: boolean; dbPath?: string; userDataDir?: string; queueSync?: boolean } = {}): App {
  const dir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'velmayil-test-'))
  const app = new App({ dbPath: opts.dbPath ?? ':memory:', userDataDir: dir })
  // Production only queues sync rows once sync was enabled/bootstrapped; tests assert queue contents, so default to "bootstrapped"
  // (tests/seams/sync-off-queue.test.ts exercises the real never-enabled default).
  if (opts.queueSync !== false) app.db.run("INSERT INTO sync_state(key,value) VALUES ('bootstrapped','1') ON CONFLICT(key) DO UPDATE SET value='1'")
  if (opts.seed !== false) seedMinimal(app)
  if (opts.modules !== false) registerAllModules(app)
  return app
}

export function seedMinimal(app: App): void {
  const db = app.db
  for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
    db.run(
      'INSERT INTO roles(name,permissions,max_discount_bp,is_system) VALUES (?,?,?,1)',
      name, JSON.stringify(perms), name === 'Cashier' ? 1000 : 10000
    )
  }
  const ownerRole = db.value<number>("SELECT id FROM roles WHERE name='Owner'")!
  const u = db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', app.uuid(), 'admin', 'Admin', ownerRole, 'x:x')
  db.run('INSERT INTO pos_terminals(uuid,code,name,is_local) VALUES (?,?,?,1)', app.uuid(), 'POS-01', 'Counter 1')
  db.run('INSERT INTO locations(uuid,name,is_default) VALUES (?,?,1)', app.uuid(), 'Main Store')
  db.run(
    `INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,address,city,state,phone,gstin,is_active,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
    app.uuid(), 1, 'Test Shop', 'Test Shop', '1 Main Road', 'Sivakasi', 'Tamil Nadu', '9876543210', '33ABCDE1234F1Z5', u.lastId
  )
  app.session = {
    userId: u.lastId,
    username: 'admin',
    name: 'Admin',
    role: 'Owner',
    permissions: ['*'],
    posId: db.value<number>('SELECT id FROM pos_terminals WHERE is_local=1')!,
    posCode: 'POS-01'
  }
}

/** Sign in as another seeded role (Manager / Cashier) without hitting the auth module. */
export function actAs(app: App, roleName: string): void {
  const role = app.db.get<{ id: number; permissions: string }>('SELECT id, permissions FROM roles WHERE name = ?', roleName)!
  const n = `${roleName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const u = app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', app.uuid(), n, roleName + ' User', role.id, 'x:x')
  app.session = { ...app.session!, userId: u.lastId, username: n, name: roleName + ' User', role: roleName, permissions: JSON.parse(role.permissions) }
}
