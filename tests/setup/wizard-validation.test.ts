import { describe, expect, it } from 'vitest'
import { validateStep, type Form } from '@/modules/setup/SetupWizard'
import { createTestApp } from '../helpers'

const base: Form = {
  shopName: 'Velan Stores', displayName: '', address: '1 Main Road', city: 'Sivakasi', state: 'Tamil Nadu', pinCode: '', phone: '', gstin: '',
  username: 'owner', ownerName: 'Velan', password: 'secret12', confirm: 'secret12', posCode: 'POS-01', posName: 'Counter 1', locationName: 'Main Store'
}
const payload = (f: Form) => ({
  shop: { shopName: f.shopName.trim(), displayName: f.displayName.trim() || f.shopName.trim(), address: f.address.trim(), city: f.city.trim(), state: f.state.trim(), pinCode: f.pinCode.trim(), phone: f.phone.trim(), gstin: f.gstin.trim().toUpperCase() },
  owner: { username: f.username.trim(), name: f.ownerName.trim() || undefined, password: f.password },
  pos: { code: f.posCode.trim().toUpperCase(), name: f.posName.trim() },
  locationName: f.locationName.trim()
})

/** First-run wizard: what step 1 accepts must also be accepted by setup.complete (which saves the shop profile). */
describe('setup wizard validation matches the server', () => {
  const cases: [string, Partial<Form>][] = [
    ['plain', {}],
    ['6-digit PIN', { pinCode: '626123' }],
    ['5-digit PIN', { pinCode: '62612' }],
    ['PIN starting with 0', { pinCode: '026123' }],
    ['PIN with letters', { pinCode: '6261A3' }],
    ['mobile', { phone: '98765 43210' }],
    ['landline with code', { phone: '+91 (4562) 220-123' }],
    ['phone with words', { phone: 'ph: 9876543210' }],
    ['too short phone', { phone: '12345' }],
    ['valid GSTIN lower case', { gstin: '33abcde1234f1z5' }],
    ['GSTIN with impossible state code', { gstin: '99ABCDE1234F1Z5' }],
    ['GSTIN too short', { gstin: '33ABCDE1234F1Z' }]
  ]
  for (const [name, patch] of cases) {
    it(name, async () => {
      const f = { ...base, ...patch }
      const clientOk = Object.keys(validateStep(0, f)).length === 0
      const app = createTestApp({ seed: false })
      const serverOk = await app.call('setup', 'complete', payload(f)).then(() => true, () => false)
      expect(clientOk).toBe(serverOk)
    })
  }

  it('names the field that is wrong', () => {
    expect(validateStep(0, { ...base, pinCode: '123' })).toEqual({ pinCode: 'PIN code must be 6 digits' })
    expect(validateStep(0, { ...base, phone: 'call me' })).toHaveProperty('phone')
    expect(validateStep(0, { ...base, shopName: '  ' })).toHaveProperty('shopName')
    expect(validateStep(1, { ...base, confirm: 'other' })).toEqual({ confirm: 'Passwords do not match' })
  })
})
