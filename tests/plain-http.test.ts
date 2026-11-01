/**
 * tests/plain-http.test.ts — the plain-http policy is a pure module, so every
 * branch of its short-circuit order gets pinned here (loopback -> floor ->
 * exact -> CIDR -> wildcard), including the two shapes that are easy to get
 * wrong and impossible to see in a UI: operator precedence on the CIDR mask and
 * label-boundary matching on `*.suffix`.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_ALLOWLIST_PREFIX,
  PLAIN_HTTP_FORBIDDEN,
  checkAllowlistEntry,
  hostOfPlainHttpTarget,
  isAllowedPlainHttpHost,
  isForbiddenPlainHttpHost,
  isPlainHttpRecord,
  isPlainHttpTarget,
  normalizeAllowlist,
  normalizeHost,
  parseIpv4,
  validateAllowlist,
} from '../src/core/plain-http.ts'

describe('parseIpv4', () => {
  it('maps a dotted quad to its 32-bit value', () => {
    expect(parseIpv4('192.168.1.23')).toBe(0xc0a80117)
    expect(parseIpv4('10.0.0.1')).toBe(0x0a000001)
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff)
  })

  it('rejects non-IPv4 and out-of-range octets instead of guessing', () => {
    expect(parseIpv4('192.168.1')).toBeNull()
    expect(parseIpv4('256.1.1.1')).toBeNull()
    expect(parseIpv4('nas.lan')).toBeNull()
    expect(parseIpv4('::1')).toBeNull()
  })
})

describe('allowlist entry shapes', () => {
  it('accepts exact hosts, IPv4 CIDR at or above the floor prefix, and wildcards', () => {
    for (const entry of ['192.168.1.23', 'nas.lan', 'PC-01', '192.168.1.0/24', '10.0.0.0/8', '*.lan']) {
      expect(checkAllowlistEntry(entry), entry).toMatchObject({ ok: true })
    }
  })

  it('rejects malformed entries loudly (a silently dropped rule reads as "configured")', () => {
    for (const entry of ['999.1.1.1/24', '192.168.1.0/33', '*.', '', '   ', 'not/valid/cidr', '192.168.1.0/abc']) {
      expect(checkAllowlistEntry(entry), entry).toMatchObject({ ok: false, code: 'malformed-allowlist-entry' })
    }
  })

  it('refuses a CIDR wider than the floor — /0 is an "allow everything" typo', () => {
    expect(MIN_ALLOWLIST_PREFIX).toBe(8)
    expect(checkAllowlistEntry('0.0.0.0/0')).toMatchObject({ ok: false })
    expect(checkAllowlistEntry('10.0.0.0/7')).toMatchObject({ ok: false })
  })

  it('validateAllowlist keeps order and count', () => {
    const checks = validateAllowlist(['nas.lan', 'bogus/../..', '*.lan'])
    expect(checks).toHaveLength(3)
    expect(checks[0]).toMatchObject({ ok: true })
    expect(checks[1]).toMatchObject({ ok: false })
  })

  it('normalizeAllowlist trims, drops empties and non-strings, dedupes', () => {
    expect(normalizeAllowlist([' nas.lan ', '', 'nas.lan', 7, null])).toEqual(['nas.lan'])
    expect(normalizeAllowlist('not-an-array')).toEqual([])
    expect(normalizeAllowlist(undefined)).toEqual([])
  })
})

describe('isAllowedPlainHttpHost — short-circuit order', () => {
  it('loopback is granted with an empty allowlist', () => {
    for (const host of ['localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]']) {
      expect(isAllowedPlainHttpHost(host, []), host).toBe(true)
    }
  })

  it('anything else is refused while the allowlist is empty', () => {
    expect(isAllowedPlainHttpHost('192.168.1.23', [])).toBe(false)
    expect(isAllowedPlainHttpHost('nas.lan', [])).toBe(false)
    expect(isAllowedPlainHttpHost('', [])).toBe(false)
  })

  it('exact host grants one machine and no neighbours', () => {
    const list = ['192.168.1.23']
    expect(isAllowedPlainHttpHost('192.168.1.23', list)).toBe(true)
    expect(isAllowedPlainHttpHost('192.168.1.24', list)).toBe(false)
  })

  it('IPv4 CIDR matches inside the range and not outside it', () => {
    expect(isAllowedPlainHttpHost('192.168.1.200', ['192.168.1.0/24'])).toBe(true)
    expect(isAllowedPlainHttpHost('192.168.2.200', ['192.168.1.0/24'])).toBe(false)
    expect(isAllowedPlainHttpHost('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(isAllowedPlainHttpHost('11.1.2.3', ['10.0.0.0/8'])).toBe(false)
    // /32 is a single host, and a non-aligned base masks correctly rather than
    // string-comparing.
    expect(isAllowedPlainHttpHost('172.16.5.9', ['172.16.5.9/32'])).toBe(true)
    expect(isAllowedPlainHttpHost('172.16.5.10', ['172.16.5.9/32'])).toBe(false)
  })

  it('a CIDR entry never matches a hostname target', () => {
    expect(isAllowedPlainHttpHost('nas.lan', ['192.168.1.0/24'])).toBe(false)
  })

  it('wildcard matches one label + suffix, never the bare suffix or a lookalike', () => {
    const list = ['*.lan']
    expect(isAllowedPlainHttpHost('nas.lan', list)).toBe(true)
    expect(isAllowedPlainHttpHost('LAN', list)).toBe(false)
    expect(isAllowedPlainHttpHost('evillian', list)).toBe(false)
  })

  it('host comparison is case- and root-dot-insensitive', () => {
    expect(normalizeHost('NAS.LAN.')).toBe('nas.lan')
    expect(isAllowedPlainHttpHost('NAS.LAN.', ['nas.lan'])).toBe(true)
    expect(isAllowedPlainHttpHost('nas.lan', ['NAS.LAN'])).toBe(true)
  })
})

describe('the never-plaintext floor', () => {
  it('is declared and covers link-local plus the unspecified address', () => {
    expect(PLAIN_HTTP_FORBIDDEN).toContain('169.254.0.0/16')
    expect(PLAIN_HTTP_FORBIDDEN).toContain('0.0.0.0')
    expect(isForbiddenPlainHttpHost('169.254.169.254')).toBe(true)
    expect(isForbiddenPlainHttpHost('169.254.1.1')).toBe(true)
    expect(isForbiddenPlainHttpHost('0.0.0.0')).toBe(true)
    expect(isForbiddenPlainHttpHost('169.253.1.1')).toBe(false)
  })

  it('an explicit allowlist entry cannot widen it', () => {
    const list = ['169.254.169.254', '169.254.0.0/16', '0.0.0.0']
    expect(isAllowedPlainHttpHost('169.254.169.254', list)).toBe(false)
    expect(isAllowedPlainHttpHost('169.254.9.9', list)).toBe(false)
    expect(isAllowedPlainHttpHost('0.0.0.0', list)).toBe(false)
  })

  it('loopback still short-circuits first — the floor does not swallow 127.x', () => {
    expect(isAllowedPlainHttpHost('127.0.0.1', [])).toBe(true)
  })
})

describe('isPlainHttpTarget / isPlainHttpRecord', () => {
  it('flags only non-loopback plaintext http', () => {
    expect(isPlainHttpTarget('http://192.168.1.23:8080')).toBe(true)
    expect(isPlainHttpTarget('http://nas.lan')).toBe(true)
    expect(isPlainHttpTarget('http://127.0.0.1:8080')).toBe(false)
    expect(isPlainHttpTarget('http://localhost:8080')).toBe(false)
    expect(isPlainHttpTarget('https://api.example.com')).toBe(false)
    expect(isPlainHttpTarget('npx')).toBe(false)
  })

  it('judges an unparseable http target by its leading host rather than looking secure', () => {
    expect(isPlainHttpTarget('http://192.168.1.5')).toBe(true)
    expect(isPlainHttpTarget('http://127.0.0.1')).toBe(false)
  })

  it('stdio records are never plain http', () => {
    expect(isPlainHttpRecord({ transport: 'stdio', url: '' })).toBe(false)
    expect(isPlainHttpRecord({ transport: 'streamable-http', url: 'https://x.test' })).toBe(false)
    expect(isPlainHttpRecord({ transport: 'streamable-http', url: 'http://10.0.0.5/mcp' })).toBe(true)
  })

  it('hostOfPlainHttpTarget names the host a user would have to grant', () => {
    expect(hostOfPlainHttpTarget('http://192.168.1.23:8080/mcp')).toBe('192.168.1.23')
    expect(hostOfPlainHttpTarget('https://API.Example.com/mcp')).toBe('api.example.com')
  })
})
