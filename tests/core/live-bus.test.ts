import { describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../helpers'
import { coalesceChanges, type ChangeEvent } from '../../src/main/core/app'

describe('live data bus', () => {
  it('fires on writes, not on reads', async () => {
    const app = createTestApp()
    const events: ChangeEvent[] = []
    app.onChange((e) => events.push(e))
    await app.call('catalog', 'list', {})
    await app.call('catalog', 'listCategories')
    expect(events).toHaveLength(0)
    await app.call('catalog', 'saveCategory', { name: 'Sparklers' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ service: 'catalog', method: 'saveCategory' })
    expect(typeof events[0].ts).toBe('number')
  })

  it('does not fire when a call throws before writing', async () => {
    const app = createTestApp()
    const events: ChangeEvent[] = []
    app.onChange((e) => events.push(e))
    await expect(app.call('catalog', 'saveCategory', { name: '' })).rejects.toBeTruthy()
    expect(events).toHaveLength(0)
  })

  it('supports listener removal and explicit emitChange', () => {
    const app = createTestApp()
    const a = vi.fn()
    const off = app.onChange(a)
    app.emitChange('sync')
    expect(a).toHaveBeenCalledTimes(1)
    expect(a.mock.calls[0][0].service).toBe('sync')
    off()
    app.emitChange('sync')
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('detects out-of-band writes (sync apply) via the watcher', async () => {
    const app = createTestApp()
    const a = vi.fn()
    app.onChange(a)
    app.startChangeWatcher(20)
    app.db.run(`INSERT INTO categories(uuid,name,updated_at) VALUES (?,?,?)`, app.uuid(), 'FromSync', Date.now())
    await new Promise((r) => setTimeout(r, 120))
    expect(a).toHaveBeenCalled()
    expect(a.mock.calls[0][0].service).toBe('sync')
    const n = a.mock.calls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(a.mock.calls.length).toBe(n) // quiet DB: no more events
    app.close()
  })

  it('coalesces bursts into one batch', async () => {
    const app = createTestApp()
    const batches: ChangeEvent[][] = []
    const stop = coalesceChanges(app, 40, (b) => batches.push(b))
    for (let i = 0; i < 5; i++) app.emitChange('catalog', 'save')
    app.emitChange('inventory', 'adjust')
    await new Promise((r) => setTimeout(r, 120))
    expect(batches).toHaveLength(1)
    expect(batches[0].map((e) => e.service).sort()).toEqual(['catalog', 'inventory'])
    stop()
    app.emitChange('catalog')
    await new Promise((r) => setTimeout(r, 80))
    expect(batches).toHaveLength(1)
  })
})
