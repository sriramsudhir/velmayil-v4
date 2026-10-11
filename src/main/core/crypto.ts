import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt password hashing: stored as "salt:hash" (hex). Shared by setup (first admin) and auth. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const test = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return expected.length === test.length && timingSafeEqual(expected, test)
}
