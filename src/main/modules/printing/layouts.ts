import type { InvoiceKind, LabelKind, TemplateConfig } from './config'
import { FONT_STACKS } from './context'

/**
 * Layout templates. Each paper size is designed on its own (not a scaled copy of another) and contains NO shop data:
 * everything comes from {{shop.*}} variables resolved from the versioned Business Profile.
 */

const flex = (a: string) => (a === 'right' ? 'flex-end' : a === 'center' ? 'center' : 'flex-start')
const font = (cfg: TemplateConfig) => FONT_STACKS[cfg.fontFamily]

/** Wrapping rules shared by every layout: long / Unicode / no-space names wrap instead of overflowing or clipping. */
export const WRAP_CSS =
  '.shop-name,.legal,.addr,.iname,.val,.wrap,.pname,.variant,.cust,.footer,.terms{overflow-wrap:anywhere;word-break:break-word;white-space:normal;min-width:0;max-width:100%;hyphens:auto}' +
  '.addr,.footer,.terms{white-space:pre-line}'

const baseCss = (cfg: TemplateConfig) =>
  `*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}` +
  `body{font-family:${font(cfg)};font-size:${cfg.fontSizePt}pt;line-height:${cfg.lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
  `img.logo{display:block;max-width:100%;height:auto;object-fit:contain}` +
  WRAP_CSS

const shopNameCss = (cfg: TemplateConfig) =>
  `.shop-name{font-size:${cfg.shopNameSizePt}pt;font-weight:${cfg.shopNameBold ? 700 : 400};text-align:${cfg.shopNameAlign};line-height:1.15}`

const doc = (css: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{invoice.title}} {{invoice.number}}</title><style>${css}</style></head><body>${body}</body></html>`

// ============================================================================ receipt 58 mm
const R58 = `
<div class="rc">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
<div class="head">
{{#logo.left}}<div class="logo-side">{{shop.logo}}</div>{{/logo.left}}
<div class="head-text">
{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}
{{#show.legalName}}<div class="legal">{{shop.legal_name}}</div>{{/show.legalName}}
{{#show.address}}<div class="addr">{{shop.address}}</div>{{/show.address}}
{{#show.cityLine}}<div class="addr">{{shop.city_line}}</div>{{/show.cityLine}}
{{#show.phone}}<div class="wrap">Ph: {{shop.phone}}</div>{{/show.phone}}
{{#show.gstin}}<div class="wrap">GSTIN: {{shop.gstin}}</div>{{/show.gstin}}
</div>
{{#logo.right}}<div class="logo-side">{{shop.logo}}</div>{{/logo.right}}
</div>
<hr class="dash">
<div class="title">{{invoice.title}}</div>
<div class="kv"><span>Bill No</span><span class="val"><b>{{invoice.number}}</b></span></div>
<div class="kv"><span>Date</span><span class="val">{{invoice.date}} {{invoice.time}}</span></div>
{{#show.cashier}}<div class="kv"><span>Cashier</span><span class="val">{{cashier.name}}</span></div>{{/show.cashier}}
{{#show.customer}}<div class="kv"><span>Customer</span><span class="val">{{customer.name}} {{customer.phone}}</span></div>{{/show.customer}}
<hr class="dash">
{{#lines}}<div class="item"><div class="iname">{{name}}</div><div class="iline"><span>{{qty}} x {{rate}}</span><span>{{total}}</span></div></div>{{/lines}}
<hr class="dash">
<div class="kv"><span>Subtotal</span><span class="val">{{sale.subtotal}}</span></div>
{{#show.discount}}<div class="kv"><span>Discount</span><span class="val">-{{sale.discount}}</span></div>{{/show.discount}}
{{#show.tax}}<div class="kv"><span>Tax (incl.)</span><span class="val">{{sale.tax}}</span></div>{{/show.tax}}
{{#show.roundOff}}<div class="kv"><span>Round off</span><span class="val">{{sale.round_off}}</span></div>{{/show.roundOff}}
<div class="kv grand"><span>TOTAL</span><span class="val">₹{{sale.total}}</span></div>
{{#show.payment}}<hr class="dash">
<div class="kv"><span>Payment</span><span class="val">{{payment.method}}</span></div>
<div class="kv"><span>Received</span><span class="val">{{payment.received}}</span></div>
{{#show.change}}<div class="kv"><span>Change</span><span class="val">{{payment.change}}</span></div>{{/show.change}}
{{/show.payment}}
{{#show.footer}}<hr class="dash"><div class="footer">{{footer}}</div>{{/show.footer}}
</div>`

const css58 = (cfg: TemplateConfig) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `@page{margin:0}` +
  `body{width:${cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `.rc{width:100%}` +
  `.logo-top{display:flex;justify-content:${flex('center')};margin-bottom:${cfg.spacingMm}mm}` +
  `.head{display:flex;gap:1.5mm;align-items:flex-start}.head-text{flex:1 1 0;min-width:0;text-align:${cfg.shopNameAlign}}.logo-side{flex:0 0 auto}` +
  `.addr,.wrap,.legal,.footer{text-align:${cfg.shopNameAlign}}` +
  `hr.dash{border:0;border-top:1px dashed #000;margin:${cfg.spacingMm}mm 0}` +
  `.title{text-align:center;font-weight:700;letter-spacing:.05em}` +
  `.kv{display:flex;justify-content:space-between;gap:2mm}.kv>span:first-child{flex:0 0 auto}.kv .val{flex:1 1 0;text-align:right}` +
  `.item{margin-bottom:${cfg.spacingMm / 2}mm}.item .iname{font-weight:700}.iline{display:flex;justify-content:space-between;gap:2mm}` +
  `.grand{font-size:${cfg.fontSizePt + 2.5}pt;font-weight:700;margin-top:1mm}`

// ============================================================================ receipt 80 mm
const R80 = `
<div class="rc">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
<div class="head head-{{logo.mode}}">
{{#logo.left}}<div class="logo-side">{{shop.logo}}</div>{{/logo.left}}
<div class="head-text">
{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}
{{#show.legalName}}<div class="legal">{{shop.legal_name}}</div>{{/show.legalName}}
{{#show.address}}<div class="addr">{{shop.address}}</div>{{/show.address}}
{{#show.cityLine}}<div class="addr">{{shop.city_line}}</div>{{/show.cityLine}}
{{#show.contact}}<div class="addr">{{#show.phone}}Ph: {{shop.phone}}{{/show.phone}}{{#show.email}} | {{shop.email}}{{/show.email}}{{#show.website}} | {{shop.website}}{{/show.website}}</div>{{/show.contact}}
{{#show.gstin}}<div class="gst">GSTIN: {{shop.gstin}}</div>{{/show.gstin}}
</div>
{{#logo.right}}<div class="logo-side">{{shop.logo}}</div>{{/logo.right}}
</div>
<div class="band">{{invoice.title}}</div>
<table class="meta"><tr><td><span class="lbl">Bill No</span><br><b class="wrap">{{invoice.number}}</b></td><td class="r"><span class="lbl">Date</span><br>{{invoice.date}} {{invoice.time}}</td></tr>
<tr><td>{{#show.cashier}}<span class="lbl">Cashier</span><br><span class="wrap">{{cashier.name}}</span>{{/show.cashier}}</td><td class="r">{{#show.pos}}<span class="lbl">Counter</span><br><span class="wrap">{{pos.name}}</span>{{/show.pos}}</td></tr>
{{#show.customer}}<tr><td colspan="2"><span class="lbl">Customer</span> <span class="wrap">{{customer.name}} {{customer.phone}}</span></td></tr>{{/show.customer}}
</table>
<table class="items"><thead><tr><th class="n">#</th><th class="d">Item</th><th class="q">Qty</th><th class="a">Rate</th><th class="a">Amount</th></tr></thead><tbody>
{{#lines}}<tr><td class="n">{{_index}}</td><td class="d"><div class="iname">{{name}}</div>{{#discount}}<div class="sub">Disc {{discount}}</div>{{/discount}}</td><td class="q">{{qty}}</td><td class="a">{{rate}}</td><td class="a">{{total}}</td></tr>{{/lines}}
</tbody></table>
<table class="tot"><tr><td>Subtotal ({{sale.qty}} items)</td><td class="a">{{sale.subtotal}}</td></tr>
{{#show.discount}}<tr><td>Discount</td><td class="a">-{{sale.discount}}</td></tr>{{/show.discount}}
{{#show.tax}}<tr><td>GST included</td><td class="a">{{sale.tax}}</td></tr>{{/show.tax}}
{{#show.roundOff}}<tr><td>Round off</td><td class="a">{{sale.round_off}}</td></tr>{{/show.roundOff}}
<tr class="grand"><td>TOTAL</td><td class="a">{{sale.total}}</td></tr></table>
{{#show.taxSummary}}<table class="gstsum"><thead><tr><th>GST %</th><th class="a">Taxable</th><th class="a">CGST</th><th class="a">SGST</th></tr></thead><tbody>
{{#taxes}}<tr><td>{{rate}}%</td><td class="a">{{taxable}}</td><td class="a">{{cgst}}</td><td class="a">{{sgst}}</td></tr>{{/taxes}}</tbody></table>{{/show.taxSummary}}
{{#show.payment}}<table class="pay"><tr><td>Paid by <b>{{payment.method}}</b></td><td class="a">Received {{payment.received}}</td></tr>{{#show.change}}<tr><td></td><td class="a">Change {{payment.change}}</td></tr>{{/show.change}}</table>{{/show.payment}}
{{#qr.enabled}}<div class="qrbox">{{shop.display_name}}<div class="qrimg">{{qr.svg}}</div><div>{{qr.label}}</div><div class="upi">{{qr.upi}}</div></div>{{/qr.enabled}}
{{#show.footer}}<div class="footer">{{footer}}</div>{{/show.footer}}
</div>`

const css80 = (cfg: TemplateConfig) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `@page{margin:0}` +
  `body{width:${cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `.logo-top{display:flex;justify-content:center;margin-bottom:${cfg.spacingMm}mm}` +
  `.head{display:flex;gap:3mm;align-items:center}.head-text{flex:1 1 0;min-width:0}.logo-side{flex:0 0 auto}` +
  `.addr,.legal,.gst{text-align:${cfg.shopNameAlign}}.gst{font-weight:700}` +
  `.band{margin:${cfg.spacingMm}mm 0;border-top:2px solid #000;border-bottom:1px solid #000;padding:.6mm 0;text-align:center;font-weight:700;letter-spacing:.12em}` +
  `table{width:100%;border-collapse:collapse}td,th{vertical-align:top;padding:.5mm 0}.r,.a{text-align:right}.lbl{font-size:${cfg.fontSizePt - 1.5}pt;text-transform:uppercase}` +
  `.meta{margin-bottom:${cfg.spacingMm}mm}.meta td{width:50%}` +
  `.items{table-layout:fixed;margin-bottom:${cfg.spacingMm}mm}.items th{border-bottom:1px solid #000;text-align:left;font-size:${cfg.fontSizePt - 1}pt}` +
  `.items th.a,.items td.a,.items th.q,.items td.q{text-align:right}.items .n{width:5mm}.items .q{width:8mm}.items .a{width:15mm}.items td{border-bottom:.25mm dotted #000;padding:.8mm 0}.items .d{padding-right:1.5mm}.sub{font-size:${cfg.fontSizePt - 1.5}pt}` +
  `.tot td{padding:.3mm 0}.grand td{font-size:${cfg.fontSizePt + 3}pt;font-weight:700;border-top:1px solid #000;border-bottom:2px solid #000;padding:1mm 0}` +
  `.gstsum{margin-top:${cfg.spacingMm}mm;font-size:${cfg.fontSizePt - 1.5}pt}.gstsum th{border-bottom:1px solid #000;text-align:left}.gstsum th.a{text-align:right}` +
  `.pay{margin-top:${cfg.spacingMm}mm;border-top:1px dashed #000}` +
  `.qrbox{margin-top:${cfg.spacingMm}mm;text-align:center;border:1px dashed #000;padding:1.5mm;display:flex;flex-direction:column;align-items:center;gap:1mm}.upi{font-size:${cfg.fontSizePt - 1.5}pt}` +
  `.footer{margin-top:${cfg.spacingMm}mm;text-align:center;border-top:1px solid #000;padding-top:1.5mm}`

// ============================================================================ invoice A4
const A4 = `
<div class="sheet">
<table class="hdr-box"><tr>
{{#logo.left}}<td class="hb-logo">{{shop.logo}}</td>{{/logo.left}}
<td class="hb-main">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}
{{#show.legalName}}<div class="legal">{{shop.legal_name}}</div>{{/show.legalName}}
{{#show.address}}<div class="addr">{{shop.address}}</div>{{/show.address}}
{{#show.cityLine}}<div class="addr">{{shop.city_line}}</div>{{/show.cityLine}}
{{#show.contact}}<div class="contact wrap">{{#show.phone}}Phone: {{shop.phone}}{{/show.phone}}{{#show.email}}  |  {{shop.email}}{{/show.email}}{{#show.website}}  |  {{shop.website}}{{/show.website}}</div>{{/show.contact}}
<div class="ids wrap">{{#show.gstin}}GSTIN: <b>{{shop.gstin}}</b>{{/show.gstin}}{{#show.pan}}   PAN: <b>{{shop.pan}}</b>{{/show.pan}}</div>
</td>
{{#logo.right}}<td class="hb-logo">{{shop.logo}}</td>{{/logo.right}}
<td class="hb-inv"><div class="inv-title">{{invoice.title}}</div><div class="k">Invoice No</div><div class="v wrap">{{invoice.number}}</div><div class="k">Date</div><div class="v">{{invoice.date}} {{invoice.time}}</div></td>
</tr></table>
<table class="info"><tr>
<td class="bill"><div class="sec-h">Bill to</div>{{#show.customer}}<div class="cust"><b>{{customer.name}}</b></div>{{#show.customerPhone}}<div>Phone: {{customer.phone}}</div>{{/show.customerPhone}}{{/show.customer}}{{^show.customer}}<div class="muted">Walk-in customer</div>{{/show.customer}}</td>
<td class="bill"><div class="sec-h">Payment</div>{{#show.payment}}{{#payment.lines}}<div>{{method}}: <b>{{amount}}</b>{{#reference}} ({{reference}}){{/reference}}</div>{{/payment.lines}}<div>Received: {{payment.received}}{{#show.change}} &nbsp; Change: {{payment.change}}{{/show.change}}</div>{{/show.payment}}{{#show.cashier}}<div class="muted">Billed by {{cashier.name}}{{#show.pos}} @ {{pos.name}}{{/show.pos}}</div>{{/show.cashier}}</td>
</tr></table>
<table class="lines"><thead><tr><th class="n">#</th><th class="d">Description</th>{{#show.hsn}}<th class="h">HSN</th>{{/show.hsn}}<th class="q">Qty</th><th class="a">Rate</th>{{#show.lineDiscount}}<th class="a">Disc.</th>{{/show.lineDiscount}}<th class="a">GST %</th><th class="a">Tax</th><th class="a">Total</th></tr></thead><tbody>
{{#lines}}<tr><td class="n">{{_index}}</td><td class="d"><div class="iname">{{name}}</div></td>{{#show.hsn}}<td class="h">{{hsn}}</td>{{/show.hsn}}<td class="q">{{qty}}</td><td class="a">{{rate}}</td>{{#show.lineDiscount}}<td class="a">{{discount}}</td>{{/show.lineDiscount}}<td class="a">{{tax_rate}}%</td><td class="a">{{tax}}</td><td class="a">{{total}}</td></tr>{{/lines}}
</tbody></table>
<table class="lower"><tr>
<td class="taxcell">{{#show.taxSummary}}<div class="sec-h">Tax summary</div><table class="taxsum"><thead><tr><th>Rate</th><th class="a">Taxable</th><th class="a">CGST</th><th class="a">SGST</th><th class="a">Total tax</th></tr></thead><tbody>{{#taxes}}<tr><td>{{rate}}%</td><td class="a">{{taxable}}</td><td class="a">{{cgst}}</td><td class="a">{{sgst}}</td><td class="a">{{tax}}</td></tr>{{/taxes}}</tbody></table>{{/show.taxSummary}}</td>
<td class="sumcell"><table class="sum"><tr><td>Subtotal</td><td class="a">{{sale.subtotal}}</td></tr>{{#show.discount}}<tr><td>Discount</td><td class="a">-{{sale.discount}}</td></tr>{{/show.discount}}<tr><td>Tax</td><td class="a">{{sale.tax}}</td></tr>{{#show.roundOff}}<tr><td>Round off</td><td class="a">{{sale.round_off}}</td></tr>{{/show.roundOff}}<tr class="grand"><td>Grand total</td><td class="a">{{sale.total}}</td></tr></table></td>
</tr></table>
{{#show.terms}}<div class="sec-h">Terms &amp; conditions</div><div class="terms">{{terms}}</div>{{/show.terms}}
<div class="sign"><div class="footer">{{#show.footer}}{{footer}}{{/show.footer}}</div><div class="sigbox">Authorised signatory{{#show.shopName}}<br><span class="wrap">for {{shop.display_name}}</span>{{/show.shopName}}</div></div>
</div>`

const cssA4 = (cfg: TemplateConfig) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `@page{size:${cfg.paperWidthMm}mm ${cfg.paperHeightMm || 297}mm;margin:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `@media screen{body{width:${cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}}` +
  `table{width:100%;border-collapse:collapse}td,th{vertical-align:top}.a{text-align:right}.muted{color:#555}` +
  `.hdr-box{border:1.2px solid #000;table-layout:auto}.hdr-box td{padding:${cfg.spacingMm}mm}` +
  `.hb-logo{width:1%;white-space:nowrap;vertical-align:middle}.hb-main{vertical-align:middle;width:99%}.hb-main .shop-name,.hb-main .legal,.hb-main .addr,.hb-main .contact,.hb-main .ids{text-align:${cfg.shopNameAlign}}` +
  `.logo-top{display:flex;justify-content:${flex(cfg.shopNameAlign)};margin-bottom:1.5mm}.legal{font-size:${cfg.fontSizePt}pt;color:#222}.ids{margin-top:1mm}` +
  `.hb-inv{width:42mm;border-left:1.2px solid #000;background:#f1f1f1;vertical-align:middle}.inv-title{font-weight:700;font-size:${cfg.fontSizePt + 2}pt;margin-bottom:1.5mm}.hb-inv .k{font-size:${cfg.fontSizePt - 2}pt;color:#444;text-transform:uppercase}.hb-inv .v{font-weight:700;margin-bottom:1mm}` +
  `.info{margin-top:${cfg.spacingMm}mm;border:1px solid #000;border-top:0}.info td{width:50%;padding:${cfg.spacingMm}mm;border-right:1px solid #000}.info td:last-child{border-right:0}.sec-h{font-size:${cfg.fontSizePt - 2}pt;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#444;margin-bottom:1mm}` +
  `.lines{margin-top:${cfg.spacingMm}mm}.lines th{background:#222;color:#fff;text-align:left;padding:1.6mm 1.5mm;font-size:${cfg.fontSizePt - 1}pt}.lines th.a,.lines th.q{text-align:right}` +
  `.lines td{padding:1.6mm 1.5mm;border-bottom:.3mm solid #bbb}.lines .n{width:8mm}.lines .q{width:12mm;text-align:right}.lines .h{width:20mm}.lines .a{white-space:nowrap}.lines .d{width:auto}.lines tr{break-inside:avoid}` +
  `.lower{margin-top:${cfg.spacingMm}mm;break-inside:avoid}.taxcell{width:55%;padding-right:${cfg.spacingMm * 2}mm}.sumcell{width:45%}` +
  `.taxsum{font-size:${cfg.fontSizePt - 1}pt}.taxsum th{border-bottom:1px solid #000;text-align:left;padding:.8mm 1mm}.taxsum th.a{text-align:right}.taxsum td{padding:.8mm 1mm;border-bottom:.2mm solid #ccc}` +
  `.sum td{padding:1mm 1.5mm}.sum .grand td{font-size:${cfg.fontSizePt + 3}pt;font-weight:700;background:#f1f1f1;border-top:1.2px solid #000;border-bottom:1.2px solid #000}` +
  `.terms{margin-bottom:${cfg.spacingMm}mm;font-size:${cfg.fontSizePt - 1}pt}` +
  `.sign{display:flex;justify-content:space-between;align-items:flex-end;gap:10mm;margin-top:${cfg.spacingMm * 3}mm;break-inside:avoid}.sign .footer{flex:1 1 0;font-style:italic}.sigbox{flex:0 0 60mm;text-align:center;border-top:1px solid #000;padding-top:1mm;font-size:${cfg.fontSizePt - 1}pt}`

// ============================================================================ invoice A5
const A5 = `
<div class="sheet">
<div class="top">
{{#logo.left}}<div class="logo-side">{{shop.logo}}</div>{{/logo.left}}
<div class="top-text">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}
{{#show.legalName}}<div class="legal">{{shop.legal_name}}</div>{{/show.legalName}}
{{#show.address}}<div class="addr">{{shop.address}}</div>{{/show.address}}
{{#show.cityLine}}<div class="addr">{{shop.city_line}}</div>{{/show.cityLine}}
</div>
{{#logo.right}}<div class="logo-side">{{shop.logo}}</div>{{/logo.right}}
</div>
<div class="strip wrap">{{#show.phone}}<span>Ph: {{shop.phone}}</span>{{/show.phone}}{{#show.email}}<span>{{shop.email}}</span>{{/show.email}}{{#show.website}}<span>{{shop.website}}</span>{{/show.website}}{{#show.gstin}}<span>GSTIN {{shop.gstin}}</span>{{/show.gstin}}</div>
<div class="titlebar"><b>{{invoice.title}}</b><span>No: <b class="wrap">{{invoice.number}}</b></span><span>{{invoice.date}} {{invoice.time}}</span></div>
{{#show.customer}}<div class="cust-line">Customer: <b class="cust">{{customer.name}}</b> {{customer.phone}}</div>{{/show.customer}}
<table class="lines"><thead><tr><th class="d">Item</th><th class="q">Qty</th><th class="a">Rate</th><th class="a">GST</th><th class="a">Amount</th></tr></thead><tbody>
{{#lines}}<tr><td class="d"><div class="iname">{{name}}</div></td><td class="q">{{qty}}</td><td class="a">{{rate}}</td><td class="a">{{tax_rate}}%</td><td class="a">{{total}}</td></tr>{{/lines}}
</tbody></table>
<div class="totals"><div class="pay">{{#show.payment}}Paid by {{payment.method}}<br>Received {{payment.received}}{{#show.change}} / Change {{payment.change}}{{/show.change}}{{/show.payment}}</div>
<table class="sum"><tr><td>Subtotal</td><td class="a">{{sale.subtotal}}</td></tr>{{#show.discount}}<tr><td>Discount</td><td class="a">-{{sale.discount}}</td></tr>{{/show.discount}}<tr><td>GST</td><td class="a">{{sale.tax}}</td></tr><tr class="grand"><td>Total</td><td class="a">{{sale.total}}</td></tr></table></div>
{{#show.terms}}<div class="terms">{{terms}}</div>{{/show.terms}}
{{#show.footer}}<div class="footer">{{footer}}</div>{{/show.footer}}
</div>`

const cssA5 = (cfg: TemplateConfig) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `@page{size:${cfg.paperWidthMm}mm ${cfg.paperHeightMm || 210}mm;margin:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `@media screen{body{width:${cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}}` +
  `table{width:100%;border-collapse:collapse}.a{text-align:right}` +
  `.top{display:flex;gap:${cfg.spacingMm * 2}mm;align-items:center;padding-bottom:${cfg.spacingMm}mm;border-bottom:2px solid #000}.top-text{flex:1 1 0;min-width:0}.logo-side{flex:0 0 auto}.logo-top{margin-bottom:1mm;display:flex;justify-content:${flex('left')}}` +
  `.top-text .addr,.top-text .legal{text-align:${cfg.shopNameAlign}}` +
  `.strip{display:flex;flex-wrap:wrap;gap:1mm 4mm;padding:1mm 0;border-bottom:1px solid #000;font-size:${cfg.fontSizePt - 0.5}pt}` +
  `.titlebar{display:flex;justify-content:space-between;gap:3mm;flex-wrap:wrap;margin:${cfg.spacingMm}mm 0;padding:1mm 2mm;background:#eee}.cust-line{margin-bottom:${cfg.spacingMm}mm}` +
  `.lines th{border-bottom:1.5px solid #000;text-align:left;padding:1mm .8mm}.lines th.a,.lines th.q{text-align:right}.lines td{padding:1mm .8mm;border-bottom:.2mm solid #999;vertical-align:top}` +
  `.lines .q{width:9mm;text-align:right}.lines .a{white-space:nowrap}` +
  `.totals{display:flex;justify-content:space-between;gap:${cfg.spacingMm * 2}mm;margin-top:${cfg.spacingMm}mm;break-inside:avoid}.pay{flex:1 1 0}.sum{width:52mm}.sum td{padding:.6mm 1mm}.sum .grand td{font-weight:700;font-size:${cfg.fontSizePt + 2.5}pt;border-top:1.5px solid #000}` +
  `.terms{margin-top:${cfg.spacingMm}mm;font-size:${cfg.fontSizePt - 1}pt;color:#222}.footer{margin-top:${cfg.spacingMm}mm;text-align:center;border-top:1px dashed #000;padding-top:1.5mm}`

export const INVOICE_LAYOUTS: Record<InvoiceKind, { template: string; css: (cfg: TemplateConfig) => string }> = {
  receipt58: { template: doc('{{{css}}}', R58), css: css58 },
  receipt80: { template: doc('{{{css}}}', R80), css: css80 },
  invoiceA4: { template: doc('{{{css}}}', A4), css: cssA4 },
  invoiceA5: { template: doc('{{{css}}}', A5), css: cssA5 }
}

// ============================================================================ labels
const labelDoc = (css: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Labels</title><style>${css}</style></head><body>${body}</body></html>`

const LABEL_BARCODE = `{{#pages}}<div class="sheet">{{#labels}}<div class="label bl">
{{#show.head}}<div class="lhead">{{#logo.enabledAny}}<div class="logo-side">{{shop.logo}}</div>{{/logo.enabledAny}}{{#show.shopName}}<div class="shop-name" style="font-size:{{product.shop_pt}}pt">{{shop.display_name}}</div>{{/show.shopName}}</div>{{/show.head}}
{{#product.has_name}}<div class="pname" style="font-size:{{product.name_pt}}pt;-webkit-line-clamp:{{product.lines}}">{{#product.name}}<span class="pn">{{product.name}}</span>{{/product.name}}{{#product.variant}} <span class="variant">{{product.variant}}</span>{{/product.variant}}</div>{{/product.has_name}}
<div class="bars">{{product.barcode_svg}}</div>
{{#show.code}}<div class="code">{{product.code}}</div>{{/show.code}}
{{#show.priceRow}}<div class="prices">{{#show.mrp}}<span class="mrp">MRP {{product.mrp}}</span>{{/show.mrp}}{{#show.price}}<b>{{product.price}}</b>{{/show.price}}</div>{{/show.priceRow}}
</div>{{/labels}}</div>{{/pages}}`

const LABEL_PRODUCT = `{{#labels}}<div class="label pl">
<div class="lhead">{{#logo.enabledAny}}<div class="logo-side">{{shop.logo}}</div>{{/logo.enabledAny}}{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}</div>
<div class="pname">{{product.name}}</div>
{{#product.variant}}<div class="variant">{{product.variant}}</div>{{/product.variant}}
<div class="prow">{{#show.sku}}<span class="sku">SKU {{product.sku}}</span>{{/show.sku}}{{#show.mrp}}<span class="mrp">MRP <s>{{product.mrp}}</s></span>{{/show.mrp}}</div>
{{#show.price}}<div class="price">{{product.price}}</div>{{/show.price}}
<div class="bars">{{product.barcode_svg}}</div>
<div class="code">{{product.code}}</div>
</div>{{/labels}}`

const labelCss = (cfg: TemplateConfig, kind: LabelKind) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `@page{size:${cfg.paperWidthMm}mm ${cfg.paperHeightMm}mm;margin:0}` +
  `.label{width:${cfg.paperWidthMm}mm;min-height:${labelBoxMm(cfg).h}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm;display:flex;flex-direction:column;gap:${cfg.spacingMm}mm;page-break-after:always;break-after:page;overflow:visible}` +
  `.label:last-child{page-break-after:auto;break-after:auto}` +
  `@media screen{.label{border:1px dashed #999;margin:2mm}}` +
  `.pname{font-weight:700;line-height:1.1}.variant{font-size:${cfg.fontSizePt - 0.5}pt}.bars{width:100%}.code{text-align:center;font-size:${cfg.fontSizePt - 1}pt;letter-spacing:.08em}` +
  (kind === 'label_barcode'
    ? `.prices{display:flex;justify-content:space-between;align-items:baseline;gap:2mm}.prices b{font-size:${cfg.fontSizePt + 3}pt}`
    : `.lhead{display:flex;gap:1.5mm;align-items:center}.lhead .shop-name{flex:1 1 0;min-width:0}.logo-side{flex:0 0 auto}.prow{display:flex;justify-content:space-between;gap:2mm;font-size:${cfg.fontSizePt - 1}pt}.price{font-size:${cfg.fontSizePt + 7}pt;font-weight:700;line-height:1}`)

/** label_barcode: fixed-size cells (one label per page, or a grid on a label sheet); content can never leave its cell. */
export const labelCellMm = (cfg: TemplateConfig) => ({ w: cfg.labelWidthMm || cfg.paperWidthMm, h: cfg.labelHeightMm || cfg.paperHeightMm })

/**
 * One label per page: the printed box is this much shorter than the label. The driver turns the page height into whole
 * printer dots and may round it DOWN (25 mm at 300 dpi = 295.3 dots -> 295); a box exactly as tall as the label then spills
 * a sliver onto a second page and the printer feeds a blank label after every label.
 */
export const LABEL_PAGE_SLACK_MM = 0.5
/** The box a label is laid out in: the cell, minus the page slack when the label is the whole page. */
export function labelBoxMm(cfg: TemplateConfig): { w: number; h: number } {
  const { w, h } = labelCellMm(cfg)
  const sheet = cfg.sheetCols > 0 && cfg.sheetRows > 0
  return { w, h: sheet ? h : Math.max(1, Math.round((h - LABEL_PAGE_SLACK_MM) * 100) / 100) }
}

const barcodeLabelCss = (cfg: TemplateConfig) => {
  const { w } = labelCellMm(cfg)
  const h = labelBoxMm(cfg).h
  const sheet = cfg.sheetCols > 0 && cfg.sheetRows > 0
  const padTop = sheet ? Math.max(0, (cfg.paperHeightMm - cfg.sheetRows * h) / 2) : 0
  const pt = cfg.fontSizePt
  return (
    baseCss(cfg) +
    `@page{size:${cfg.paperWidthMm}mm ${cfg.paperHeightMm}mm;margin:0}` +
    (sheet
      ? `.sheet{width:${cfg.paperWidthMm}mm;padding:${padTop.toFixed(2)}mm 0 0 ${Math.max(0, (cfg.paperWidthMm - cfg.sheetCols * w) / 2).toFixed(2)}mm;display:grid;grid-template-columns:repeat(${cfg.sheetCols},${w}mm);grid-template-rows:repeat(${cfg.sheetRows},${h}mm);break-after:page;page-break-after:always;overflow:hidden}`
      : `.sheet{width:${w}mm;height:${h}mm;break-after:page;page-break-after:always;overflow:hidden}`) +
    `.sheet:last-child{break-after:auto;page-break-after:auto}` +
    `.label{width:${w}mm;height:${h}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm;display:flex;flex-direction:column;justify-content:space-between;gap:${cfg.spacingMm}mm;overflow:hidden;break-inside:avoid}` +
    `@media screen{.label{outline:1px dashed #999;outline-offset:-1px}.sheet{margin-bottom:3mm}}` +
    `.label>*{min-width:0;flex:0 0 auto}` +
    `.lhead{display:flex;align-items:center;justify-content:center;gap:1mm;max-width:100%}.logo-side{flex:0 0 auto}.shop-name{font-weight:${cfg.shopNameBold ? 700 : 400};line-height:1.1;overflow-wrap:anywhere;min-width:0}` +
    `.pname{flex:0 1 auto!important;min-height:0;text-align:center;font-weight:700;line-height:1.12;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${cfg.nameMaxLines}}` +
    `.pname .variant{font-weight:400}` +
    `.bars{width:100%;overflow:hidden}` +
    `.code{text-align:center;font-size:${Math.max(4.5, pt - 0.5)}pt;letter-spacing:.06em;line-height:1.1;overflow-wrap:anywhere}` +
    `.prices{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;flex-wrap:wrap;line-height:1.1}.prices .mrp{font-size:${pt}pt}.prices b{font-size:${pt + 3}pt;margin-left:auto}`
  )
}

export const LABEL_LAYOUTS: Record<LabelKind, { template: string; css: (cfg: TemplateConfig) => string }> = {
  label_barcode: { template: labelDoc('{{{css}}}', LABEL_BARCODE), css: barcodeLabelCss },
  label_product: { template: labelDoc('{{{css}}}', LABEL_PRODUCT), css: (c) => labelCss(c, 'label_product') }
}

// ============================================================================ report header + table
const REPORT = `
<div class="report">
<div class="rhead">
{{#logo.left}}<div class="logo-side">{{shop.logo}}</div>{{/logo.left}}
<div class="rtext">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
{{#show.shopName}}<div class="shop-name">{{shop.display_name}}</div>{{/show.shopName}}
{{#show.address}}<div class="addr">{{shop.address}}{{#show.cityLine}}, {{shop.city_line}}{{/show.cityLine}}</div>{{/show.address}}
<div class="rmeta wrap">{{#show.phone}}<span>Ph: {{shop.phone}}</span>{{/show.phone}}{{#show.gstin}}<span>GSTIN: {{shop.gstin}}</span>{{/show.gstin}}</div>
</div>
{{#logo.right}}<div class="logo-side">{{shop.logo}}</div>{{/logo.right}}
</div>
{{#show.title}}<div class="rtitle wrap">{{report.title}}</div>{{/show.title}}
{{#show.period}}<div class="rsub wrap">{{report.subtitle}}</div>{{/show.period}}
<table class="rt"><thead><tr>{{#columns}}<th style="text-align:{{align}}">{{header}}</th>{{/columns}}</tr></thead>
<tbody>{{#rows}}<tr>{{#cells}}<td style="text-align:{{align}}">{{v}}</td>{{/cells}}</tr>{{/rows}}</tbody>
{{#totals}}<tfoot><tr>{{#cells}}<td style="text-align:{{align}}">{{v}}</td>{{/cells}}</tr></tfoot>{{/totals}}
</table>
<div class="rfoot">Printed {{report.printed_at}}</div>
</div>`

const reportCss = (cfg: TemplateConfig) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  // landscape = the wide size itself: `size: <w> <h> landscape` is not valid CSS and the browser drops the whole declaration
  `@page{size:${cfg.landscape ? `${cfg.paperHeightMm || 297}mm ${cfg.paperWidthMm}mm` : `${cfg.paperWidthMm}mm ${cfg.paperHeightMm || 297}mm`};margin:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `@media screen{body{width:${cfg.landscape ? cfg.paperHeightMm || 297 : cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}}` +
  `.rhead{display:flex;gap:${cfg.spacingMm * 2}mm;align-items:center;border-bottom:2px solid #000;padding-bottom:${cfg.spacingMm}mm}.rtext{flex:1 1 0;min-width:0}.logo-side{flex:0 0 auto}.logo-top{margin-bottom:1mm;display:flex;justify-content:flex-start}` +
  `.rtext .addr,.rtext .rmeta{text-align:${cfg.shopNameAlign}}.rmeta{display:flex;flex-wrap:wrap;gap:0 5mm}` +
  `.rtitle{margin-top:${cfg.spacingMm}mm;font-size:${cfg.fontSizePt + 4}pt;font-weight:700}.rsub{color:#333;margin-bottom:${cfg.spacingMm}mm}` +
  `table.rt{width:100%;border-collapse:collapse;margin-top:${cfg.spacingMm}mm}.rt th{background:#222;color:#fff;padding:1.2mm 1.5mm;font-size:${cfg.fontSizePt - 0.5}pt}.rt td{padding:1mm 1.5mm;border-bottom:.2mm solid #bbb;overflow-wrap:anywhere}.rt tr{break-inside:avoid}.rt tfoot td{font-weight:700;border-top:1.5px solid #000;background:#f1f1f1}` +
  `.rfoot{margin-top:${cfg.spacingMm}mm;color:#555;font-size:${cfg.fontSizePt - 2}pt}`

export const REPORT_LAYOUT = { template: doc('{{{css}}}', REPORT).replace('{{invoice.title}} {{invoice.number}}', '{{report.title}}'), css: reportCss }

// ============================================================================ test page (calibration)
export const TEST_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test print</title><style>{{{css}}}</style></head><body><div class="tp">
{{#logo.top}}<div class="logo-top">{{shop.logo}}</div>{{/logo.top}}
<div class="head">{{#logo.left}}<div class="logo-side">{{shop.logo}}</div>{{/logo.left}}<div class="head-text">
<div class="shop-name">{{shop.display_name}}</div>
{{#show.address}}<div class="addr">{{shop.address}}</div>{{/show.address}}{{#show.cityLine}}<div class="addr">{{shop.city_line}}</div>{{/show.cityLine}}
{{#show.phone}}<div class="wrap">Ph: {{shop.phone}}</div>{{/show.phone}}</div>{{#logo.right}}<div class="logo-side">{{shop.logo}}</div>{{/logo.right}}</div>
<div class="tt">TEST PRINT &mdash; {{test.paper}}</div>
<div class="info wrap">Paper {{test.width}} x {{test.height}} &nbsp; Printable width {{test.printable}} mm<br>Printed {{test.when}}</div>
<div class="ruler"><div class="ticks">{{#ticks}}<span class="tick{{#major}} major{{/major}}" style="left:{{left}}mm">{{#label}}<i>{{label}}</i>{{/label}}</span>{{/ticks}}</div></div>
<div class="grid"></div>
<div class="info">Ruler is in millimetres: check that 10 mm marks measure 10 mm. The box must touch both edges of the printable area without being cut off.</div>
<div class="dk"><b>Print darkness {{test.darkness}} of 9</b><div class="dk-s">Small text: ABCDEFGHIJ abcdefghij 01234 56789 ₹</div><div class="dk-bar"></div>
<div class="info">The small text must be sharp and the bar solid black. Too faint or too heavy: change Print darkness under Printing &gt; Printers.</div></div>
<div class="bc"><div class="bars">{{test.barcode}}</div><div class="code">{{test.code}}</div>
<div class="info">Scan this barcode: it must read {{test.code}}. Bars are sized for a {{test.dpi}} dpi printer.</div></div>
</div></body></html>`

export const testCss = (cfg: TemplateConfig, printableMm: number) =>
  baseCss(cfg) +
  shopNameCss(cfg) +
  `body{width:${cfg.paperWidthMm}mm;padding:${cfg.marginTopMm}mm ${cfg.marginRightMm}mm ${cfg.marginBottomMm}mm ${cfg.marginLeftMm}mm}` +
  `.head{display:flex;gap:2mm;align-items:center}.head-text{flex:1 1 0;min-width:0}.logo-side{flex:0 0 auto}.logo-top{display:flex;justify-content:center;margin-bottom:2mm}` +
  `.tt{margin:3mm 0 1mm;font-weight:700;text-align:center;border:1px solid #000;padding:1mm}.info{font-size:${Math.max(6, cfg.fontSizePt - 1)}pt;margin:1.5mm 0}` +
  `.ruler{position:relative;height:9mm;border:1px solid #000;width:${printableMm}mm;margin-top:3mm}.ticks{position:relative;height:100%}` +
  `.tick{position:absolute;bottom:0;width:0;height:2.5mm;border-left:.3mm solid #000}.tick.major{height:5mm}.tick i{position:absolute;top:-4mm;left:-2mm;font-size:6pt;font-style:normal}` +
  `.ruler,.grid,.dk,.bc{break-inside:avoid;page-break-inside:avoid}` +
  `.dk{margin-top:3mm}.dk-s{font-size:6pt;line-height:1.2}.dk-bar{width:${Math.min(printableMm, 30)}mm;height:3mm;background:#000;margin:1mm 0}` +
  `.bc{margin-top:2mm;width:${printableMm}mm}.bc .bars{width:${Math.min(printableMm, 60)}mm}.bc .code{font-size:${Math.max(6, cfg.fontSizePt - 1)}pt;letter-spacing:.08em}` +
  `.grid{width:${printableMm}mm;height:22mm;margin-top:3mm;border:1px solid #000;background-image:linear-gradient(#000 .25mm,transparent .25mm),linear-gradient(90deg,#000 .25mm,transparent .25mm);background-size:5mm 5mm}`
