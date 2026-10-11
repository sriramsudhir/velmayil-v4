import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { actAs, createTestApp } from '../helpers'
import type { BusinessProfileService } from '../../src/main/modules/businessProfile/service'
import { makePng, makeSvg } from '../printing/fixtures'

const svc = (app: ReturnType<typeof createTestApp>) => app.get<BusinessProfileService>('businessProfile')
const rows = (app: ReturnType<typeof createTestApp>, sql: string, ...p: any[]) => app.db.all<any>(sql, ...p)

describe('business profile versioning', () => {
  it('save creates a new immutable version and flips the active flag atomically', () => {
    const app = createTestApp()
    const v1 = svc(app).getActive()
    expect(v1.version).toBe(1)
    const v2 = svc(app).save({ shopName: 'New Name', displayName: 'New Name' })
    expect(v2.version).toBe(2)
    expect(v2.id).not.toBe(v1.id)
    expect(rows(app, 'SELECT version FROM business_profile_versions WHERE is_active = 1')).toEqual([{ version: 2 }])
    // old version untouched
    expect(svc(app).getById(v1.id).shopName).toBe('Test Shop')
    // other fields carried over (merge over active)
    expect(v2.gstin).toBe('33ABCDE1234F1Z5')
    // rows are immutable at the DB level
    expect(() => app.db.run('UPDATE business_profile_versions SET shop_name = ? WHERE id = ?', 'Hacked', v1.id)).toThrow(/immutable/)
    expect(() => app.db.run('DELETE FROM business_profile_versions WHERE id = ?', v1.id)).toThrow()
  })

  it('an identical save is a no-op (no noise versions)', () => {
    const app = createTestApp()
    const before = svc(app).getActive()
    const again = svc(app).save({ shopName: before.shopName })
    expect(again.id).toBe(before.id)
    expect(app.db.value('SELECT COUNT(*) FROM business_profile_versions')).toBe(1)
  })

  it('first-run: save creates v1 when none exists', () => {
    const app = createTestApp({ seed: false })
    expect(svc(app).findActive()).toBeNull()
    const p = svc(app).save({ shopName: 'Fresh Shop', gstin: '33ABCDE1234F1Z5', phone: '+91 98765 43210' })
    expect(p.version).toBe(1)
    expect(p.displayName).toBe('Fresh Shop')
    expect(svc(app).getActive().id).toBe(p.id)
  })

  it('audits old/new for shop name, logo sha, address, GSTIN and phone', () => {
    const app = createTestApp()
    svc(app).save({ shopName: 'Renamed', phone: '9000011111', address: '9 New Street', gstin: '29ABCDE1234F1Z5' })
    const a = rows(app, "SELECT * FROM audit_log WHERE entity='business_profile' ORDER BY id DESC LIMIT 1")[0]
    expect(a.action).toBe('profile.save')
    expect(a.user_name).toBe('Admin')
    expect(a.pos_code).toBe('POS-01')
    const o = JSON.parse(a.old_json)
    const n = JSON.parse(a.new_json)
    expect(o.shopName).toBe('Test Shop')
    expect(n.shopName).toBe('Renamed')
    expect(o.phone).toBe('9876543210')
    expect(n.phone).toBe('9000011111')
    expect(o.address).toBe('1 Main Road')
    expect(n.address).toBe('9 New Street')
    expect(o.gstin).toBe('33ABCDE1234F1Z5')
    expect(n.gstin).toBe('29ABCDE1234F1Z5')
    expect(n).toHaveProperty('logoSha256')
    expect(o).toHaveProperty('logoSha256')
  })

  it('enqueues a sync snapshot for every version (without logo bytes)', () => {
    const app = createTestApp()
    const p = svc(app).save({ shopName: 'Sync Me' })
    const q = rows(app, "SELECT * FROM sync_queue WHERE entity='business_profile_versions'")
    expect(q).toHaveLength(1)
    const snap = JSON.parse(q[0].payload_json)
    expect(snap.uuid).toBeTruthy()
    expect(snap.row.shop_name).toBe('Sync Me')
    expect(snap.row.version).toBe(p.version)
    expect(JSON.stringify(snap)).not.toMatch(/"bytes"/)
  })

  it('historical documents: getForDocument obeys the reprint policy', () => {
    const app = createTestApp()
    const old = svc(app).getActive()
    svc(app).save({ shopName: 'Brand New' })
    expect(svc(app).getForDocument(old.id).shopName).toBe('Test Shop') // default policy = original
    expect(svc(app).getForDocument(old.id, 'current').shopName).toBe('Brand New')
    app.setSetting('reprint_profile_policy', 'current')
    expect(svc(app).getForDocument(old.id).shopName).toBe('Brand New')
    expect(svc(app).getForDocument(old.id, 'original').shopName).toBe('Test Shop')
    expect(svc(app).getForDocument(null).shopName).toBe('Brand New')
  })
})

describe('profile validation', () => {
  const app = createTestApp()
  const bad = (input: Record<string, unknown>, msg: RegExp) => expect(() => svc(app).save(input)).toThrow(msg)
  it('requires a name', () => {
    bad({ shopName: '   ' }, /Shop name is required/)
    bad({ shopName: '' }, /required/)
  })
  it('validates GSTIN, PAN, PIN, phone, email', () => {
    bad({ gstin: '33ABCDE1234F1Z' }, /GSTIN/)
    bad({ gstin: '99ABCDE1234F1Z5' }, /GSTIN/)
    bad({ gstin: '33ABCDE1234F1X5' }, /GSTIN/)
    bad({ pan: 'ABCD12345E' }, /PAN/)
    bad({ pinCode: '12345' }, /PIN/)
    bad({ pinCode: '0123456' }, /PIN/)
    bad({ phone: 'call me' }, /phone/i)
    bad({ phone: '12' }, /phone/i)
    bad({ email: 'not-an-email' }, /email/i)
    bad({ website: 'not a site' }, /website/i)
  })
  it('accepts valid values and normalises case', () => {
    const p = svc(app).save({ gstin: '33abcde1234f1z5', pan: 'abcde1234f', pinCode: '626123', phone: '04562 223344, +91 98765 43210', email: 'a@b.in', website: 'www.example.in' })
    expect(p.gstin).toBe('33ABCDE1234F1Z5')
    expect(p.pan).toBe('ABCDE1234F')
    expect(p.phone).toBe('04562 223344, +91 98765 43210')
  })
  it('validates logo settings range', () => {
    expect(() => svc(app).save({ logoSettings: { visible: true, widthMm: 500, heightMm: 0, alignment: 'center', position: 'top' } })).toThrow()
    expect(() => svc(app).save({ logoSettings: { visible: true, widthMm: 20, heightMm: 0, alignment: 'middle', position: 'top' } })).toThrow()
  })
  it('stores Tamil / Unicode names and addresses exactly', () => {
    const a = createTestApp()
    const name = 'ஸ்ரீ லட்சுமி பட்டாசு கடை'
    const p = svc(a).save({ shopName: name, displayName: name, address: 'பிள்ளையார் கோவில் தெரு, சிவகாசி', footerText: 'நன்றி! மீண்டும் வருக' })
    const back = svc(a).getById(p.id)
    expect(back.shopName).toBe(name)
    expect(back.address).toBe('பிள்ளையார் கோவில் தெரு, சிவகாசி')
    expect(back.footerText).toBe('நன்றி! மீண்டும் வருக')
    expect(a.db.value("SELECT shop_name FROM business_profile_versions WHERE is_active=1")).toBe(name)
  })
})

describe('permissions (via the IPC dispatcher)', () => {
  it('cashier can view but not edit; manager cannot edit; owner can', async () => {
    const app = createTestApp()
    actAs(app, 'Cashier')
    expect(((await app.call('businessProfile', 'getActive')) as any).shopName).toBe('Test Shop')
    await expect(app.call('businessProfile', 'save', { shopName: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('businessProfile', 'setLogo', { data: makePng(10, 10).toString('base64') })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('businessProfile', 'removeLogo')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('businessProfile', 'setReprintPolicy', { policy: 'current' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    actAs(app, 'Manager')
    await expect(app.call('businessProfile', 'save', { shopName: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    app.session = { ...app.session!, permissions: ['*'] }
    const saved = (await app.call('businessProfile', 'save', { shopName: 'Owner Edit' })) as any
    expect(saved.version).toBe(2)
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE action='profile.save'")).toBe(1)
  })
  it('validation errors surface as VALIDATION AppErrors', async () => {
    const app = createTestApp()
    await expect(app.call('businessProfile', 'save', { gstin: 'bad' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('logo lifecycle', () => {
  it('setLogo stores the asset, creates a version, audits the sha and queues the asset for sync', () => {
    const app = createTestApp()
    const png = makePng(400, 200)
    const { profile, quality } = svc(app).setLogo({ data: png })
    expect(profile.version).toBe(2)
    expect(profile.logoAssetId).toBeGreaterThan(0)
    const a = app.db.get<any>('SELECT * FROM logo_assets WHERE id = ?', profile.logoAssetId!)!
    expect(a.width_px).toBe(400)
    expect(a.height_px).toBe(200)
    expect(a.mime).toBe('image/png')
    expect(Buffer.from(a.bytes).equals(png)).toBe(true)
    expect(a.print_bytes).toBeTruthy()
    expect(quality.effectiveDpi).toBeGreaterThan(0)
    const audit = app.db.get<any>("SELECT * FROM audit_log WHERE action='profile.logo_set'")!
    expect(JSON.parse(audit.new_json).logoSha256).toBe(a.sha256)
    expect(JSON.parse(audit.old_json).logoSha256).toBe('')
    const q = rows(app, "SELECT * FROM sync_queue WHERE entity='logo_assets'")
    expect(q).toHaveLength(1)
    const payload = JSON.parse(q[0].payload_json)
    expect(q[0].entity_uuid).toBe(a.sha256)
    expect(Buffer.from(payload.bytesBase64, 'base64').equals(png)).toBe(true)
    // profile snapshot carries the sha, not the bytes
    const snap = JSON.parse(rows(app, "SELECT payload_json FROM sync_queue WHERE entity='business_profile_versions' ORDER BY id DESC LIMIT 1")[0].payload_json)
    expect(snap.row.logo_sha256).toBe(a.sha256)
  })

  it('getLogo exposes print bytes, data URI and dimensions', () => {
    const app = createTestApp()
    const { profile } = svc(app).setLogo({ data: makePng(300, 100).toString('base64') })
    const logo = svc(app).getLogo(profile.logoAssetId)!
    expect(logo.widthPx).toBe(300)
    expect(logo.dataUri()).toMatch(/^data:image\/png;base64,/)
    expect(svc(app).getLogo(null)).toBeNull()
    expect(svc(app).getLogo(99999)).toBeNull()
  })

  it('replacing keeps history; the old version still shows the old logo; same file is de-duplicated', () => {
    const app = createTestApp()
    const a = svc(app).setLogo({ data: makePng(100, 100) }).profile
    const b = svc(app).setLogo({ data: makePng(120, 60) }).profile
    expect(a.logoAssetId).not.toBe(b.logoAssetId)
    expect(svc(app).getById(a.id).logoAssetId).toBe(a.logoAssetId)
    const c = svc(app).setLogo({ data: makePng(120, 60) }).profile
    expect(c.logoAssetId).toBe(b.logoAssetId)
    expect(app.db.value('SELECT COUNT(*) FROM logo_assets')).toBe(2)
  })

  it('removeLogo creates a version without a logo (old versions keep theirs)', () => {
    const app = createTestApp()
    const withLogo = svc(app).setLogo({ data: makePng(100, 100) }).profile
    const removed = svc(app).removeLogo()
    expect(removed.logoAssetId).toBeNull()
    expect(removed.version).toBe(withLogo.version + 1)
    expect(svc(app).getById(withLogo.id).logoAssetId).toBe(withLogo.logoAssetId)
    expect(svc(app).removeLogo().id).toBe(removed.id) // nothing to remove -> no new version
    expect(app.db.get<any>("SELECT * FROM audit_log WHERE action='profile.logo_remove'")).toBeTruthy()
  })

  it('rejects bad files and keeps the profile unchanged', () => {
    const app = createTestApp()
    expect(() => svc(app).setLogo({ data: Buffer.from('not an image at all') })).toThrow(/Unsupported/)
    expect(() => svc(app).setLogo({ data: Buffer.concat([makePng(5, 5), Buffer.alloc(2_200_000)]) })).toThrow(/2 MB/)
    expect(app.db.value('SELECT COUNT(*) FROM business_profile_versions')).toBe(1)
    expect(app.db.value('SELECT COUNT(*) FROM logo_assets')).toBe(0)
  })

  it('stores sanitised SVG only', () => {
    const app = createTestApp()
    const dirty = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><script>bad()</script><rect width="10" height="10"/></svg>')
    const { profile } = svc(app).setLogo({ data: dirty })
    const logo = svc(app).getLogo(profile.logoAssetId)!
    expect(logo.mime).toBe('image/svg+xml')
    expect(logo.bytes.toString()).not.toMatch(/script|onload/)
    expect(logo.widthPx).toBe(10)
    void makeSvg
  })

  it('logo settings are saved with the version and survive logo changes', () => {
    const app = createTestApp()
    svc(app).save({ logoSettings: { visible: true, widthMm: 25, heightMm: 0, alignment: 'left', position: 'inline-left' } })
    const p = svc(app).setLogo({ data: makePng(100, 50) }).profile
    expect(p.logoSettings).toEqual({ visible: true, widthMm: 25, heightMm: 0, alignment: 'left', position: 'inline-left' })
  })

  it('works fully offline (no network access is attempted)', () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => { throw new Error('network used!') }) as typeof fetch
    try {
      const app = createTestApp()
      svc(app).save({ shopName: 'Offline Shop' })
      svc(app).setLogo({ data: makePng(50, 50) })
      expect(svc(app).getActive().shopName).toBe('Offline Shop')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('multi-POS inbound (applySynced)', () => {
  const remoteRow = (over: Record<string, unknown> = {}) => ({
    uuid: 'remote-uuid-1',
    row: {
      uuid: 'remote-uuid-1', version: 2, shop_name: 'Remote Shop', legal_name: '', display_name: 'Remote Shop', short_name: '', address: 'R street', city: '', state: '', pin_code: '',
      phone: '', email: '', website: '', gstin: '', pan: '', footer_text: '', logo_sha256: '', logo_settings_json: '{}', header_settings_json: '{}', created_at: Date.now() + 60_000, ...over
    }
  })

  it('adopts a newer remote version and keeps local history', () => {
    const app = createTestApp()
    const local = svc(app).getActive()
    const r = svc(app).applySynced(remoteRow() as any)
    expect(r).toMatchObject({ adopted: true, activated: true })
    expect(svc(app).getActive().shopName).toBe('Remote Shop')
    expect(svc(app).getById(local.id).shopName).toBe('Test Shop')
    expect(app.db.value('SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    // inbound apply must not echo back to the queue
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='business_profile_versions'")).toBe(0)
  })

  it('keeps an older remote version as history without activating it', () => {
    const app = createTestApp()
    svc(app).save({ shopName: 'Local Newer' })
    const r = svc(app).applySynced(remoteRow({ created_at: 1000 }) as any)
    expect(r).toMatchObject({ adopted: true, activated: false })
    expect(svc(app).getActive().shopName).toBe('Local Newer')
    expect(svc(app).listVersions().map((v) => v.shopName)).toContain('Remote Shop')
  })

  it('is idempotent and renumbers on version clashes', () => {
    const app = createTestApp()
    expect(svc(app).applySynced(remoteRow({ version: 1 }) as any).adopted).toBe(true) // v1 already exists locally
    expect(svc(app).applySynced(remoteRow({ version: 1 }) as any).adopted).toBe(false)
    expect(app.db.value('SELECT COUNT(*) FROM business_profile_versions')).toBe(2)
    expect(app.db.value('SELECT MAX(version) FROM business_profile_versions')).toBe(2)
  })

  it('parks a version whose logo has not arrived, then releases it with the logo asset', () => {
    const app = createTestApp()
    const png = makePng(80, 40)
    const sha = createHash('sha256').update(png).digest('hex')
    const r = svc(app).applySynced(remoteRow({ logo_sha256: sha }) as any)
    expect(r).toMatchObject({ adopted: false, pending: true })
    expect(svc(app).getActive().shopName).toBe('Test Shop')
    const rel = svc(app).applySyncedLogo({ sha256: sha, bytesBase64: png.toString('base64') })
    expect(rel).toMatchObject({ stored: true, released: 1 })
    const active = svc(app).getActive()
    expect(active.shopName).toBe('Remote Shop')
    expect(svc(app).getLogo(active.logoAssetId)!.widthPx).toBe(80)
  })
})
