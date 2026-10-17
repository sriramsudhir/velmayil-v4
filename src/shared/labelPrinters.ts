/** Printer names that speak TSPL (TSC-compatible label printers): the label printer profile suggests direct printing for them. */
export const isTsplPrinterName = (name: string): boolean => /4\s*barcode|\btsc\b|xprinter|gprinter|\bhprt\b|rongta|\btvs\b|\bsnbc\b|munbyn|itpp|zjiang|\bbeeprt/i.test(name)
