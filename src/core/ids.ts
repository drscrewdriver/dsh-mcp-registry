/**
 * Ids and key-safety helpers.
 *
 * `sanitizeId` is the single gate for every persisted identifier. Note the
 * explicit proto-key denylist: `__proto__` matches the character class, and an
 * id is only ever stored as a VALUE, but defense in depth is cheap here — a
 * denylisted id can never drift into a record-key position through a future
 * refactor.
 */

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** Keys that must never become own-properties via assignment (proto pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function sanitizeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!ID_RE.test(trimmed)) return null
  if (UNSAFE_KEYS.has(trimmed.toLowerCase())) return null
  return trimmed
}

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key)
}

/**
 * Assign `key` onto a plain object only when the key is safe. Returns whether
 * the assignment happened. Used for every dynamic-key write (toolPermissions,
 * env, headers) so a hostile import can never reach the prototype machinery —
 * `obj[key] = v` with key `__proto__` silently mutates the prototype instead
 * of creating an own property.
 */
export function safeAssign<T extends object>(target: T, key: string, value: unknown): boolean {
  if (isUnsafeKey(key)) return false
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  return true
}

/** Deep check: does any reachable own key of this parsed JSON value look like a proto key? */
export function hasUnsafeKeyDeep(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeKeyDeep(item, depth + 1))
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isUnsafeKey(key)) return true
    if (hasUnsafeKeyDeep((value as Record<string, unknown>)[key], depth + 1)) return true
  }
  return false
}
