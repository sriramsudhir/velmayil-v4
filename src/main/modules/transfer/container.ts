import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { removeQuiet } from '../backup/engine'

/**
 * "Everything" transfer file (*.vmove): ONE self-describing file that carries a whole-database snapshot.
 *
 *   bytes 0..15   magic  "VELMAYIL-XFER-1\n"
 *   bytes 16..19  header length N (uint32, big endian)
 *   N bytes       header JSON (utf-8): versions, source terminal, payload size + SHA-256, row counts, summary
 *   32 bytes      SHA-256 of the header JSON  (a changed header is detected)
 *   rest          payload: a plain SQLite file (VACUUM INTO snapshot, journal_mode=DELETE)
 *
 * The checksums detect damage (bad USB stick, cut-off copy, edited file); they are not a signature.
 */
export const TRANSFER_EXT = '.vmove'
const MAGIC = Buffer.from('VELMAYIL-XFER-1\n', 'latin1')
const MAX_HEADER = 4 * 1024 * 1024
const CHUNK = 1 << 20

/** Numbers shown to the owner before and after an import (same query on the file and on the live database). */
export type Summary = Record<string, number>

export interface TransferHeader {
  format: 1
  kind: 'everything'
  app: 'velmayil-pos'
  appVersion: string
  createdAt: number
  source: { deviceUuid: string; posCode: string; posName: string; shopName: string }
  /** highest schema_migrations.version in the payload */
  schemaVersion: number
  schemaCount: number
  payload: { sizeBytes: number; sha256: string }
  /** row count of every table in the payload */
  tables: Record<string, number>
  summary: Summary
}

/** A problem with the file itself; the message is written for the shop owner. */
export class TransferFileError extends Error {}

const fail = (m: string): never => {
  throw new TransferFileError(m)
}

function readExact(fd: number, len: number, pos: number): Buffer {
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got)
    if (n <= 0) break
    got += n
  }
  if (got !== len) fail('This file is incomplete (it ends too early). Copy it again from the other laptop.')
  return buf
}

/** Write the container atomically (".partial" then rename). Returns the size of the finished file. */
export function writeContainer(payloadPath: string, dest: string, header: TransferHeader): number {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(json.length, 0)
  const partial = dest + '.partial'
  const out = openSync(partial, 'w')
  try {
    for (const b of [MAGIC, len, json, createHash('sha256').update(json).digest()]) writeSync(out, b)
    const inp = openSync(payloadPath, 'r')
    try {
      const buf = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        const n = readSync(inp, buf, 0, buf.length, null)
        if (n <= 0) break
        writeSync(out, buf, 0, n)
      }
    } finally {
      closeSync(inp)
    }
  } catch (e) {
    closeSync(out)
    removeQuiet(partial)
    throw e
  }
  closeSync(out)
  removeQuiet(dest)
  renameSync(partial, dest)
  return statSync(dest).size
}

/** Read + validate the header (magic, header checksum, shape). Throws TransferFileError. */
export function readHeader(path: string): { header: TransferHeader; payloadOffset: number; fileSize: number } {
  if (!existsSync(path)) fail('The file was not found: ' + path)
  const fileSize = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    if (fileSize < MAGIC.length + 4 + 32 || !readExact(fd, MAGIC.length, 0).equals(MAGIC)) {
      fail('This is not a Velmayil "Export everything" file. Choose the file that ends with ' + TRANSFER_EXT + '.')
    }
    const n = readExact(fd, 4, MAGIC.length).readUInt32BE(0)
    if (n < 2 || n > MAX_HEADER || MAGIC.length + 4 + n + 32 > fileSize) fail('This file is damaged (its description cannot be read). Export it again on the other laptop.')
    const json = readExact(fd, n, MAGIC.length + 4)
    const sum = readExact(fd, 32, MAGIC.length + 4 + n)
    if (!createHash('sha256').update(json).digest().equals(sum)) fail('This file is damaged or was changed after it was exported (checksum of the description does not match). Export it again on the other laptop.')
    let header: TransferHeader
    try {
      header = JSON.parse(json.toString('utf8')) as TransferHeader
    } catch {
      return fail('This file is damaged (its description cannot be read). Export it again on the other laptop.')
    }
    if (!header || header.app !== 'velmayil-pos' || header.kind !== 'everything') fail('This is not a Velmayil "Export everything" file.')
    if (header.format !== 1) fail('This file was made by a newer version of the app (file format ' + String(header.format) + '). Update the app on this laptop first.')
    if (!header.payload || typeof header.payload.sha256 !== 'string' || !Number.isInteger(header.payload.sizeBytes) || !Number.isInteger(header.schemaVersion)) {
      fail('This file is damaged (its description is incomplete). Export it again on the other laptop.')
    }
    return { header, payloadOffset: MAGIC.length + 4 + n + 32, fileSize }
  } finally {
    closeSync(fd)
  }
}

/**
 * Check the payload against the header (size + SHA-256). With `dest` the payload is also written there (the import works
 * on that private copy, so the file cannot change between the check and its use). Throws TransferFileError.
 */
export function checkPayload(path: string, dest?: string): TransferHeader {
  const { header, payloadOffset, fileSize } = readHeader(path)
  if (fileSize - payloadOffset !== header.payload.sizeBytes) {
    fail(`This file is incomplete or damaged (it holds ${fileSize - payloadOffset} bytes of data, ${header.payload.sizeBytes} expected). Copy it again from the other laptop.`)
  }
  const h = createHash('sha256')
  const inp = openSync(path, 'r')
  const out = dest ? openSync(dest, 'w') : undefined
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = payloadOffset
    for (;;) {
      const n = readSync(inp, buf, 0, buf.length, pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      if (out !== undefined) writeSync(out, buf, 0, n)
      pos += n
    }
  } finally {
    closeSync(inp)
    if (out !== undefined) closeSync(out)
  }
  if (h.digest('hex') !== header.payload.sha256) {
    if (dest) removeQuiet(dest)
    fail('This file is damaged or was changed after it was exported (checksum does not match). Nothing was imported. Export it again on the other laptop.')
  }
  return header
}
