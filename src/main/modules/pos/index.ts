import type { App } from '../../core/app'
import { registerSettingDef } from '../../core/settings'
import { PosService } from './service'
import { installDevicePermissionHandlers } from './deviceAccess'
import { listWindowsDevices } from './scannerDevices'

export const order = 50

export function register(app: App): void {
  // Shop UPI id used for the on-screen payment QR (Settings > Billing). Format name@bank.
  registerSettingDef({ key: 'billing.upi_id', default: '', label: 'Shop UPI id for payment QR (e.g. shop@upi)', group: 'Billing', kind: 'text', maxLength: 80 })
  installDevicePermissionHandlers()
  const svc = new PosService(app)
  app.provide('pos', svc)
  // every method enforces its own permission inside the service (requirePermission) and validates input with zod
  app.expose('pos', {
    scan: (a: { code: string }) => svc.scan(a?.code),
    // Settings > Scanner "connected devices": what Windows itself reports (USB/HID devices, failed enumerations)
    scannerDevices: async () => { app.requirePermission('pos.sell'); return listWindowsDevices() },
    search: (a: { text: string; limit?: number }) => svc.search(a?.text, a?.limit),
    cartPrice: (a) => svc.cartPrice(a),
    completeSale: (a) => svc.completeSale(a),
    getSale: (a) => svc.getSale(a),
    listSales: (a) => svc.listSales(a),
    voidSale: (a) => svc.voidSale(a),
    deleteSale: (a) => svc.deleteSale(a),
    createReturn: (a) => svc.createReturn(a),
    getReturn: (a) => svc.getReturn(a),
    holdCart: (a) => svc.holdCart(a),
    listHeld: () => svc.listHeld(),
    resumeHeld: (a) => svc.resumeHeld(a),
    discardHeld: (a) => svc.discardHeld(a),
    getCurrentShift: () => svc.getCurrentShift(),
    openShift: (a) => svc.openShift(a),
    closeShift: (a) => svc.closeShift(a),
    shiftSummary: (a) => svc.shiftSummary(a),
    findCustomerByPhone: (a: { phone: string }) => svc.findCustomerByPhone(a?.phone),
    listCustomers: (a) => svc.listCustomers(a),
    createCustomer: (a) => svc.createCustomer(a),
    settings: () => ({ maxDiscountBp: svc.myMaxDiscountBp(), canDiscountUnlimited: app.can('pos.discount.unlimited'), pricesIncludeTax: svc.pricesIncludeTax(), roundOff: app.setting('pos.round_off', '1') === '1', requireShift: app.setting('pos.require_shift', '0') === '1', allowNegative: app.setting('inventory.allow_negative', '0') === '1', upiId: app.setting('billing.upi_id', '').trim(), payeeName: app.db.value<string>('SELECT COALESCE(NULLIF(display_name, \'\'), shop_name) FROM business_profile_versions WHERE is_active = 1') ?? '' })
  })
}
