import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from '../../src/shared/ipc'
import { toAppError } from '../../src/main/core/validate'
import { createTestApp } from '../helpers'

/** What the IPC bridge turns thrown values into: the renderer must always get a short, readable message. */
describe('toAppError (IPC error mapping)', () => {
  it('passes AppError through untouched', () => {
    const e = new AppError('CONFLICT', 'Already there', { a: 1 })
    expect(toAppError(e)).toBe(e)
  })

  it('turns a raw ZodError into VALIDATION "field: problem", never the JSON dump of issues', () => {
    let thrown: unknown
    try {
      z.object({ id: z.string().min(1), filters: z.object({ limit: z.number().int() }).optional() }).parse({ id: '', filters: { limit: 1.5 } })
    } catch (e) {
      thrown = e
    }
    const err = toAppError(thrown)
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('VALIDATION')
    expect(err.message.startsWith('id: ')).toBe(true)
    expect(err.message).not.toMatch(/^\s*\[/) // not the JSON array zod puts in .message
    expect(err.message).not.toContain('"path"')
    expect((err.details as { fields: Record<string, string> }).fields).toHaveProperty('filters.limit')
  })

  it('a report call with bad arguments reaches the caller as readable text once mapped', async () => {
    const app = createTestApp()
    let thrown: unknown
    try {
      await app.call('reports', 'run', { id: '' })
    } catch (e) {
      thrown = e
    }
    const err = toAppError(thrown)
    expect(err.code).toBe('VALIDATION')
    expect(err.message).toMatch(/^id: /)
  })

  it('explains SQLite constraint failures in plain words', () => {
    const app = createTestApp()
    let unique: unknown
    try {
      app.db.run("INSERT INTO pos_terminals(uuid,code,name,is_local) VALUES ('x','POS-01','Dup',0)")
    } catch (e) {
      unique = e
    }
    const u = toAppError(unique)
    expect(u.code).toBe('CONFLICT')
    expect(u.message).toBe('A record with the same code already exists')

    let fk: unknown
    try {
      app.db.run("INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES ('u9','ghost','Ghost',99999,'x:x')")
    } catch (e) {
      fk = e
    }
    const f = toAppError(fk)
    expect(f.code).toBe('CONFLICT')
    expect(f.message).not.toMatch(/FOREIGN KEY/)
  })

  it('never produces an empty or "[object Object]" message', () => {
    for (const v of [undefined, null, {}, { foo: 1 }, 42, new Error('')]) {
      const e = toAppError(v)
      expect(e.code).toBe('INTERNAL')
      expect(e.message).toBe('Unexpected error')
    }
    expect(toAppError('plain text').message).toBe('plain text')
    expect(toAppError(new Error('boom')).message).toBe('boom')
  })
})
