import { toPaise } from '@shared/money'

export interface ProductListRow {
  id: number; uuid: string; name: string; active: boolean
  categoryId: number | null; category: string | null; brandId: number | null; brand: string | null
  hsn: string; taxRateBp: number; unit: string; trackStock: boolean; hasImage: boolean
  variantCount: number; sku: string; barcode: string | null
  mrp: number; price: number; cost: number; minPrice: number; maxPrice: number
  stock: number; lowStock: boolean; updatedAt: number
  trackUnits?: boolean; unitPrefix?: string | null
}
export interface VariantRow {
  id: number; uuid: string; productId: number; name: string; sku: string; barcode: string | null; aliases: string[]
  mrp: number; price: number; cost: number; reorderLevel: number; active: boolean; stock: number
}
export interface ProductDetail {
  id: number; uuid: string; name: string; description: string
  categoryId: number | null; category: string | null; brandId: number | null; brand: string | null
  hsn: string; taxRateBp: number; unit: string; trackStock: boolean; active: boolean
  imageId: number | null; imageDataUri: string | null; variants: VariantRow[]
  trackUnits?: boolean; unitPrefix?: string | null
}
export interface Category { id: number; name: string; parentId: number | null; active: boolean; path: string; productCount: number }
export interface Brand { id: number; name: string; active: boolean; productCount: number }

export interface ImportPreview {
  filename: string
  headers: string[]
  mapping: Record<string, number | null>
  sample: string[][]
  counts: { total: number; creates: number; updates: number; unchanged: number; invalid: number; warnings: number; newCategories: number; newBrands: number }
  issues: { rowNo: number; name: string; sku: string; errors: string[]; warnings: string[] }[]
  issuesTruncated: boolean
  canCommit: boolean
}

/** "123.45" / "₹1,299" -> paise; '' -> 0; NaN -> null */
export function parseRupees(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, '')
  if (t === '') return 0
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null
  return toPaise(t)
}
export const rupees = (paise: number): string => (paise === 0 ? '' : (paise / 100).toFixed(2))

export const GST_SLABS = [0, 5, 12, 18, 28]
export const bpToPct = (bp: number): string => String(Number((bp / 100).toFixed(2)))

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error ?? new Error('Could not read file'))
    r.readAsDataURL(file)
  })
}

/** Save a base64 payload returned by exportFile/templateFile when the main process had no save dialog. */
export function downloadBase64(res: { bytesBase64?: string; filename: string; mime: string }): void {
  if (!res.bytesBase64) return
  const bin = atob(res.bytesBase64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = res.filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
