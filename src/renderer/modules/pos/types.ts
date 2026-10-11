import type { Discount } from '@shared/billing'

/** Mirrors the main-process SellableVariant (renderer cannot import main code). */
export interface Variant {
  variantId: number
  productId: number
  productName: string
  variantName: string
  displayName: string
  sku: string
  barcode: string | null
  hsn: string
  taxRateBp: number
  mrp: number
  price: number
  cost: number
  unit: string
  trackStock: boolean
  stock: number
  /** present when the variant is tracked per unit (units.* backend) */
  trackUnits?: boolean
}

export interface CartLine {
  key: string
  variantId: number
  name: string
  sku: string
  qty: number
  price: number            // catalog price (paise)
  overridePrice: number | null
  discount: Discount
  taxRateBp: number
  trackStock: boolean
  stock: number
  /** tracked per unit: qty === unitCodes.length, units are added by scanning */
  tracked?: boolean
  unitCodes?: string[]
}

export interface CartCustomer { id?: number; name: string; phone: string }

export interface SavedCart {
  lines: CartLine[]
  billDiscount: Discount
  customer: CartCustomer | null
  note: string
}

export interface PosSettings {
  maxDiscountBp: number
  canDiscountUnlimited: boolean
  pricesIncludeTax: boolean
  roundOff: boolean
  requireShift: boolean
  allowNegative: boolean
  /** shop UPI id (billing.upi_id) + payee name for the payment QR */
  upiId?: string
  payeeName?: string
}

export interface SaleResult { saleId: number; invoiceNo: string; total: number; paid: number; change: number; duplicate: boolean; unitCodes?: string[] }

export type PayMethod = 'cash' | 'upi' | 'card' | 'credit' | 'other'
export interface PayRow { id: number; method: PayMethod; amount: number; reference: string }

/** approvalId comes from auth.verifyApprover (<ApprovalDialog>); the username/password form is the legacy inline path. */
export interface Approval { approvalId?: number; approverUsername?: string; approverPassword?: string }
