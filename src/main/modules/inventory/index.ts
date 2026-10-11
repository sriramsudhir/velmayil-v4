import type { App } from '../../core/app'
import { InventoryService } from './service'
import { PurchasesService } from './purchases'
import { likeTerm } from './util'
import { registerSettingDef } from '../../core/settings'

export const order = 40

export { InventoryService, PurchasesService }

export function register(app: App): void {
  // read by purchases.create; without a definition it could not be changed from Settings
  registerSettingDef({ key: 'inventory.cost_method', default: 'last', label: 'Product cost after a purchase', group: 'Inventory', kind: 'enum', options: ['last', 'weighted'] })
  const inv = app.provide('inventory', new InventoryService(app))
  const pur = app.provide('purchases', new PurchasesService(app))

  // Every service method enforces its own permission + zod validation (so cross-module callers are checked too).
  app.expose('inventory', {
    locations: () => inv.locations(),
    categories: () => inv.categories(),
    lookup: (a) => inv.lookup(a),
    search: (a: { text?: string; limit?: number }) => {
      app.requirePermission('inventory.view')
      const t = likeTerm(String(a?.text ?? ''))
      // empty or wildcard-only text ("%", "_") never dumps the catalogue
      if (t === '%%' || !/[^%_\s]/.test(String(a?.text ?? ''))) return []
      return app.lookup.search(String(a.text), Math.min(Number(a.limit) || 30, 100)).map((v) => ({ ...v, cost: app.can('reports.profit') ? v.cost : null }))
    },
    stock: (a) => inv.stock(a),
    valuation: (a) => inv.valuation(a),
    ledger: (a) => inv.ledger(a),
    verifyLedger: () => inv.verifyLedger(),
    lowStock: (a) => inv.lowStock(a),
    lowStockCount: (a) => inv.lowStockCount(a),
    adjust: (a) => inv.adjust(a),
    adjustments: (a) => inv.adjustments(a),
    countCreate: (a) => inv.countCreate(a),
    countList: (a) => inv.countList(a),
    countGet: (a) => inv.countGet(a),
    countSet: (a) => inv.countSet(a),
    countScan: (a) => inv.countScan(a),
    countApply: (a) => inv.countApply(a),
    countCancel: (a) => inv.countCancel(a),
    transferCreate: (a) => inv.transferCreate(a),
    transferList: (a) => inv.transferList(a),
    transferGet: (a) => inv.transferGet(a)
  })

  app.expose('purchases', {
    list: (a) => pur.list(a),
    get: (a) => pur.get(a),
    create: (a) => pur.create(a),
    cancel: (a) => pur.cancel(a),
    recordPayment: (a) => pur.recordPayment(a),
    supplierList: (a) => pur.supplierList(a),
    supplierGet: (a) => pur.supplierGet(a),
    supplierSave: (a) => pur.supplierSave(a),
    supplierSetActive: (a) => pur.supplierSetActive(a),
    payables: (a) => pur.payables(a),
    returnCreate: (a) => pur.returnCreate(a),
    returnList: (a) => pur.returnList(a),
    returnGet: (a) => pur.returnGet(a)
  })
}
