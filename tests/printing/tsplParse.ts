import type { MonoBitmap } from '../../src/main/modules/printing/tspl'

/** Read a TSPL job back: the command lines and every BITMAP (bits re-inverted, 1 = black) with its PRINT count. */
export function parseTspl(buf: Buffer): { lines: string[]; labels: { bitmap: MonoBitmap; copies: number }[] } {
  const lines: string[] = []
  const labels: { bitmap: MonoBitmap; copies: number }[] = []
  let i = 0
  let last: MonoBitmap | null = null
  while (i < buf.length) {
    const head = buf.subarray(i, i + 7).toString('latin1')
    if (head === 'BITMAP ') {
      let j = i
      let commas = 0
      while (commas < 5) if (buf[j++] === 0x2c) commas++
      const [, , wb, h] = buf.subarray(i + 7, j - 1).toString('latin1').split(',').map(Number)
      const data = buf.subarray(j, j + wb * h)
      const bits = Buffer.from(data.map((b) => ~b & 0xff))
      last = { width: wb * 8, height: h, bits }
      lines.push(`BITMAP ${wb}x${h}`)
      i = j + wb * h + 2
      continue
    }
    const end = buf.indexOf('\r\n', i, 'latin1')
    const line = buf.subarray(i, end).toString('latin1')
    lines.push(line)
    const m = /^PRINT 1,(\d+)$/.exec(line)
    if (m && last) labels.push({ bitmap: last, copies: Number(m[1]) })
    i = end + 2
  }
  return { lines, labels }
}
