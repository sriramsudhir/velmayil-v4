/** Pure (no DB, no clock reads) security helpers. Unit-tested in tests/auth. */

export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MS = 5 * 60 * 1000
export const DEFAULT_AUTOLOCK_MINUTES = 10
export const DEFAULT_PASSWORD_MIN = 8

/** Idle check with an injected clock. minutes <= 0 disables auto-lock. */
export function isIdleExpired(lastActivityMs: number, nowMs: number, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  return nowMs - lastActivityMs >= minutes * 60_000
}

export interface PasswordPolicy { minLength: number; requireDigit: boolean }

/** Returns an error message, or null when the password satisfies the policy. */
export function validatePassword(password: string, username: string, policy: PasswordPolicy): string | null {
  if (password.length < policy.minLength) return `Password must be at least ${policy.minLength} characters`
  if (password.length > 200) return 'Password is too long'
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return 'Password must not be the same as the username'
  if (policy.requireDigit && !/\d/.test(password)) return 'Password must contain at least one digit'
  return null
}

const WEAK_PINS = new Set(['0000', '1111', '1234', '000000', '111111', '123456'])
export function validatePin(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits'
  if (WEAK_PINS.has(pin)) return 'PIN is too easy to guess'
  return null
}

export interface DiffEntry { path: string; old: unknown; new: unknown }

/** Flat JSON diff for the audit viewer. Accepts JSON strings or values; returns changed leaf paths. */
export function diffJson(a: unknown, b: unknown): DiffEntry[] {
  const parse = (v: unknown) => {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return v }
  }
  const out: DiffEntry[] = []
  const walk = (x: unknown, y: unknown, path: string) => {
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k)
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out.push({ path: path || '(value)', old: x, new: y })
    }
  }
  walk(parse(a), parse(b), '')
  return out
}
