/** Cross-module data contracts. Domain-specific types live in each module's own shared file. */
import type { Paise } from './money'

export interface BusinessProfile {
  id: number               // business_profile_versions.id (a specific version)
  version: number
  shopName: string
  legalName: string
  displayName: string      // used on receipts/headers: {{shop.display_name}}
  shortName: string
  address: string
  city: string
  state: string
  pinCode: string
  phone: string
  email: string
  website: string
  gstin: string
  pan: string
  footerText: string
  logoAssetId: number | null
  logoSettings: LogoSettings
  headerSettings: ReportHeaderSettings
  createdAt: number
  createdBy: number | null
}

export interface LogoSettings {
  visible: boolean
  widthMm: number          // 0 = auto
  heightMm: number         // 0 = auto (aspect ratio is always preserved)
  alignment: 'left' | 'center' | 'right'
  position: 'top' | 'inline-left' | 'inline-right'
}

export interface ReportHeaderSettings {
  showLogo: boolean
  showShopName: boolean
  showAddress: boolean
  showPhone: boolean
  showGstin: boolean
}

export type PaymentMethod = 'cash' | 'upi' | 'card' | 'credit' | 'other'

/** Template/print data model: what the printing engine receives for an invoice. Built by printing from DB. */
export interface InvoiceLine { name: string; sku: string; qty: number; unitPrice: Paise; discount: Paise; taxRateBp: number; taxAmount: Paise; total: Paise; hsn?: string }
export interface InvoiceDoc {
  invoiceNumber: string
  createdAt: number
  posName: string
  cashierName: string
  customerName: string
  customerPhone: string
  lines: InvoiceLine[]
  subtotal: Paise
  discount: Paise
  tax: Paise
  roundOff: Paise
  total: Paise
  payments: { method: string; amount: Paise; reference?: string }[]
  received: Paise
  change: Paise
  isReturn?: boolean
  profile: BusinessProfile
}

export interface Page<T> { rows: T[]; total: number }
export interface ListQuery { search?: string; limit?: number; offset?: number }
