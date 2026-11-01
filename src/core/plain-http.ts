/**
 * src/core/plain-http.ts — the plain (non-TLS) http policy for remote connectors.
 *
 * Why this exists: the loopback-only rule (core/model.ts) was the ONLY place the
 * scheme was judged, and it judged it at WRITE time — while `store.load()` asserts
 * the connector array straight out of registry.json and `McpHttpSession` fetches
 * whatever `record.url` says. So a hand-edited row reached the network unjudged,
 * and the "default block" was a decoration. This module is therefore consumed at
 * BOTH seams: write time (early, actionable error) and connect time (the real
 * boundary, `bridge.ts`). One judgement, two enforcement points — a rule cannot
 * be true in one and false in the other.
 *
 * Defaults are closed: an empty allowlist is byte-for-byte the old behaviour.
 * `PLAIN_HTTP_FORBIDDEN` is a code-level floor that no allowlist entry can widen,
 * because a writable plaintext route to the link-local metadata range is not a
 * convenience anyone asked for.
 */

/** Ranges a plaintext http connector may NEVER reach, allowlist notwithstanding. */
export const PLAIN_HTTP_FORBIDDEN = ['169.254.0.0/16', '0.0.0.0'] as const

/**
 * Broadest CIDR a user may grant. `/8` already covers a whole RFC1918 block;
 * anything wider (notably `/0`) is a typo-shaped "allow everything" and is
 * rejected rather than honoured.
 */
export const MIN_ALLOWLIST_PREFIX = 8

/** A malformed entry is reported, never silently ignored — a dropped rule reads as "configured". */
export type AllowlistCheck =
  | { ok: true; entry: string }
  | { ok: false; code: 'malformed-allowlist-entry'; entry: string; reason: string }

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)
const CIDR_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}/(\\d{1,2})$`)
// A bare host: dns-ish labels, or an IPv6 literal in brackets.
const HOST_RE = /^[a-z0-9._-]+$/i

/** `192.168.1.23` -> 3232235807; anything not a dotted-quad IPv4 -> null. */
export function parseIpv4(host: string): number | null {
  const m = IPV4_RE.exec(host)
  if (!m) return null
  const parts = [m[1], m[2], m[3], m[4]] as const
  let n = 0
  for (const p of parts) {
    const oct = Number(p)
    if (!Number.isFinite(oct) || oct > 255) return null
    n = n * 256 + oct
  }
  return n
}

/** Hosts on the never-plaintext floor. Compared as raw hosts, not via the allowlist. */
export function isForbiddenPlainHttpHost(host: string): boolean {
  const h = normalizeHost(host)
  if (h === '0.0.0.0') return true
  return h.startsWith('169.254.')
}

/**
 * Loopback hosts, single source of truth. `model.ts` imports this for its own
 * write-time rule so the dependency runs one way (policy -> model): a rule that
 * lives in the validator and is re-implemented by the policy is how the two
 * enforcement seams drift apart.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Lowercase, drop the root-label dot and any IPv6 bracket pair. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
}

/** Validate one allowlist entry's shape: exact host, IPv4 CIDR (>= /8), or `*.suffix`. */
export function checkAllowlistEntry(raw: unknown): AllowlistCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'malformed-allowlist-entry', entry: String(raw ?? ''), reason: 'entry is not a string' }
  const entry = raw.trim()
  if (entry === '') return { ok: false, code: 'malformed-allowlist-entry', entry: raw, reason: 'entry is empty' }
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2)
    if (suffix === '' || !HOST_RE.test(suffix)) {
      return { ok: false, code: 'malformed-allowlist-entry', entry, reason: 'wildcard needs a suffix host, e.g. "*.lan"' }
    }
    return { ok: true, entry }
  }
  const cidr = CIDR_RE.exec(entry)
  if (cidr) {
    const prefix = Number(cidr[5])
    if (prefix > 32) return { ok: false, code: 'malformed-allowlist-entry', entry, reason: 'IPv4 prefix exceeds 32' }
    if (prefix < MIN_ALLOWLIST_PREFIX) {
      return { ok: false, code: 'malformed-allowlist-entry', entry, reason: `IPv4 prefix must be /${MIN_ALLOWLIST_PREFIX} or narrower — a wider range is an "allow everything" typo` }
    }
    return { ok: true, entry }
  }
  if (entry.includes('/')) {
    return { ok: false, code: 'malformed-allowlist-entry', entry, reason: 'a "/" entry must be IPv4 CIDR like 192.168.1.0/24' }
  }
  if (!HOST_RE.test(entry)) {
    return { ok: false, code: 'malformed-allowlist-entry', entry, reason: 'expected a host, IPv4 CIDR, or "*.suffix"' }
  }
  return { ok: true, entry }
}

/** Per-entry validation for the settings surface. Order and count are preserved. */
export function validateAllowlist(entries: readonly unknown[]): AllowlistCheck[] {
  return entries.map(checkAllowlistEntry)
}

/** Deduped, trimmed, non-empty entries — what the runtime actually matches against. */
export function normalizeAllowlist(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const raw of entries) {
    if (typeof raw !== 'string') continue
    const e = raw.trim()
    if (e !== '' && !out.includes(e)) out.push(e)
  }
  return out
}

/**
 * Is this hostname granted a plaintext http connection?
 * Short-circuit order is the policy: loopback (always fine) -> floor (never fine)
 * -> exact host -> IPv4 CIDR -> `*.suffix`.
 */
export function isAllowedPlainHttpHost(hostname: string, allowlist: readonly string[]): boolean {
  const host = normalizeHost(hostname)
  if (host === '') return false
  if (isLoopbackHost(host)) return true
  if (isForbiddenPlainHttpHost(host)) return false
  for (const raw of allowlist) {
    const entry = raw.trim()
    if (entry === '') continue
    if (entry.startsWith('*.')) {
      const suffix = normalizeHost(entry.slice(2))
      // The leading-dot test is the whole boundary rule: `*.lan` grants `nas.lan`
      // but NOT the bare `lan` and NOT `evillian`. A multi-level suffix
      // (`sub.nas.lan`) is deliberately NOT matched one-label-deep — wildcard
      // semantics here are "one label + suffix", and anything wider should be
      // written as an exact entry so the grant is legible.
      if (host.endsWith(`.${suffix}`)) return true
      continue
    }
    const cidr = CIDR_RE.exec(entry)
    if (cidr) {
      const base = parseIpv4(`${cidr[1]}.${cidr[2]}.${cidr[3]}.${cidr[4]}`)
      const prefix = Number(cidr[5])
      if (base === null || prefix > 32) continue
      const target = parseIpv4(host)
      if (target === null) continue
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
      // Parentheses on BOTH sides are load-bearing: `===` binds tighter than `>>>`.
      if (((target & mask) >>> 0) === ((base & mask) >>> 0)) return true
      continue
    }
    if (normalizeHost(entry) === host) return true
  }
  return false
}

/**
 * Does this connector target a NON-loopback plaintext http endpoint?
 * Takes a string origin/URL (write path, display path) or a record shape.
 * `https`/`wss` and stdio rows are never "plain http".
 */
export function isPlainHttpTarget(target: string): boolean {
  const value = (target ?? '').trim()
  if (!value.toLowerCase().startsWith('http://')) return false
  let host: string
  try {
    host = new URL(value).hostname
  } catch {
    // `redactTarget` falls back to the raw string for unparseable urls; judge those
    // by their leading host so the display path cannot silently look "secure".
    host = value.slice('http://'.length).split('/')[0]?.split(':')[0] ?? ''
  }
  if (host === '') return false
  return !isLoopbackHost(host)
}

/** Record-shaped form of the same question, for the two enforcement seams. */
export function isPlainHttpRecord(record: { transport: string; url: string }): boolean {
  return record.transport === 'streamable-http' && isPlainHttpTarget(record.url)
}

/** The host a user would have to grant — echoed back in every rejection message. */
export function hostOfPlainHttpTarget(target: string): string {
  const value = (target ?? '').trim()
  try {
    return normalizeHost(new URL(value).hostname)
  } catch {
    return normalizeHost(value.replace(/^https?:\/\//, '').split('/')[0]?.split(':')[0] ?? value)
  }
}
