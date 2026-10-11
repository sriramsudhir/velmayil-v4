import { describe, it, expect } from 'vitest'
import { Db } from '../../src/main/db/driver'
import { allMigrations, runMigrations, sortMigrations, type Migration } from '../../src/main/db/migrate'

describe('migrations', () => {
  it('apply cleanly on a fresh database, in version order', () => {
    const db = new Db(':memory:')
    const ran = runMigrations(db)
    const all = allMigrations().map((m) => m.version)
    expect(ran).toEqual(all)
    expect(all[0]).toBe(1)
    expect(all).toEqual([...all].sort((a, b) => a - b))
    expect(db.value<number>('SELECT COUNT(*) FROM schema_migrations')).toBe(all.length)
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    db.close()
  })

  it('is idempotent', () => {
    const db = new Db(':memory:')
    runMigrations(db)
    const before = db.value<number>("SELECT COUNT(*) FROM sqlite_master")
    expect(runMigrations(db)).toEqual([])
    expect(db.value<number>("SELECT COUNT(*) FROM sqlite_master")).toBe(before)
    db.close()
  })

  it('only runs migrations that are not yet applied (upgrade path)', () => {
    const db = new Db(':memory:')
    const [first, ...rest] = allMigrations()
    runMigrations(db, [first])
    expect(runMigrations(db)).toEqual(rest.map((m) => m.version))
    db.close()
  })

  it('detects duplicate versions across files', () => {
    const a: Migration = { version: 5, name: 'a', sql: 'SELECT 1' }
    const b: Migration = { version: 5, name: 'b', sql: 'SELECT 1' }
    expect(() => sortMigrations([a, b])).toThrow(/Duplicate migration version 5/)
    expect(() => runMigrations(new Db(':memory:'), [a, b])).toThrow(/Duplicate/)
    expect(() => sortMigrations([{ version: 0, name: 'z' }])).toThrow(/Invalid/)
  })

  it('the shipped migration set has unique versions in the owned ranges', () => {
    const versions = allMigrations().map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('a failing migration rolls back completely and is not recorded', () => {
    const db = new Db(':memory:')
    const bad: Migration = { version: 1, name: 'bad', sql: 'CREATE TABLE t1(a); CREATE TABLE t1(a);' }
    expect(() => runMigrations(db, [bad])).toThrow()
    expect(db.value<number>("SELECT COUNT(*) FROM sqlite_master WHERE name='t1'")).toBe(0)
    expect(db.value<number>('SELECT COUNT(*) FROM schema_migrations')).toBe(0)
    db.close()
  })
})
