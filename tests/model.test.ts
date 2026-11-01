import { describe, expect, it } from 'vitest'
import {
  MASK,
  normalizeConnectorInput,
  publicView,
  redactTarget,
} from '../src/core/model.ts'
import { assertNoCredentialLeak } from '../src/surface/tool.ts'

const NOW = 1_700_000_000_000

describe('normalizeConnectorInput — the args bug guards', () => {
  it('accepts the canonical stdio shape and keeps args as a string array', () => {
    const rec = normalizeConnectorInput('github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, { provenance: 'manual', now: NOW })
    expect(rec.transport).toBe('stdio')
    expect(rec.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(rec.enabled).toBe(true)
  })

  it('REJECTS string args loudly (the openhanako silent-drop bug)', () => {
    expect(() =>
      normalizeConnectorInput('bad', { command: 'npx', args: '-y mcp-server' }, { provenance: 'manual', now: NOW }),
    ).toThrowError(/args must be a JSON array/)
  })

  it('REJECTS non-string items inside args', () => {
    expect(() =>
      normalizeConnectorInput('bad', { command: 'npx', args: ['-y', 42] }, { provenance: 'manual', now: NOW }),
    ).toThrowError(/args\[1\] is number/)
  })

  it('REJECTS a command with whitespace and no args (the glue bug source)', () => {
    expect(() =>
      normalizeConnectorInput('bad', { command: 'npx -y mcp-server' }, { provenance: 'manual', now: NOW }),
    ).toThrowError(/command contains whitespace/)
  })

  it('a command with whitespace AND args is accepted (legit spaced paths)', () => {
    const rec = normalizeConnectorInput('spaced', { command: '/opt/my tools/srv', args: ['--flag'] }, { provenance: 'manual', now: NOW })
    expect(rec.command).toBe('/opt/my tools/srv')
  })

  it('rejects unknown transport-less entries with neither url nor command', () => {
    expect(() => normalizeConnectorInput('bad', {}, { provenance: 'manual', now: NOW })).toThrowError(/neither url nor command/)
  })

  it('http is loopback-only; https is always fine', () => {
    expect(() => normalizeConnectorInput('l', { url: 'http://127.0.0.1:3000/mcp' }, { provenance: 'manual', now: NOW })).not.toThrow()
    expect(() => normalizeConnectorInput('l', { url: 'http://example.com/mcp' }, { provenance: 'manual', now: NOW })).toThrowError(/loopback/)
    expect(() => normalizeConnectorInput('l', { url: 'https://example.com/mcp' }, { provenance: 'manual', now: NOW })).not.toThrow()
    expect(() => normalizeConnectorInput('l', { url: 'ftp://example.com' }, { provenance: 'manual', now: NOW })).toThrowError(/http\/https/)
  })

  it('an allowlisted host is admitted; the floor and neighbours are not', () => {
    const allow = { provenance: 'manual' as const, now: NOW, plainHttpAllowlist: ['192.168.1.23', 'nas.lan', '10.0.0.0/8'] }
    expect(normalizeConnectorInput('a', { url: 'http://192.168.1.23:8080/mcp' }, allow).url).toBe('http://192.168.1.23:8080/mcp')
    expect(normalizeConnectorInput('b', { url: 'http://NAS.LAN/mcp' }, allow).transport).toBe('streamable-http')
    expect(() => normalizeConnectorInput('c', { url: 'http://192.168.1.24/mcp' }, allow)).toThrowError(/loopback/)
    expect(() => normalizeConnectorInput('d', { url: 'http://169.254.169.254/mcp' }, { ...allow, plainHttpAllowlist: ['169.254.0.0/16'] })).toThrowError(/never-plaintext floor/)
  })

  it('an empty allowlist is byte-for-byte the old loopback-only rule', () => {
    expect(() => normalizeConnectorInput('e', { url: 'http://example.com/mcp' }, { provenance: 'manual', now: NOW, plainHttpAllowlist: [] })).toThrowError(/loopback/)
    expect(normalizeConnectorInput('f', { url: 'http://127.0.0.1:1/mcp' }, { provenance: 'manual', now: NOW, plainHttpAllowlist: [] }).transport).toBe('streamable-http')
  })

  it('rejection names the host to grant, since the error is the only guidance a CLI user gets', () => {
    expect(() => normalizeConnectorInput('g', { url: 'http://192.168.1.9:8080/mcp' }, { provenance: 'manual', now: NOW })).toThrowError(/add "192\.168\.1\.9" to plainHttpAllowlist/)
  })

  it('sse and remote spellings normalize onto streamable-http', () => {
    const rec = normalizeConnectorInput('legacy', { transport: 'sse', url: 'https://x.example/sse' }, { provenance: 'import', now: NOW })
    expect(rec.transport).toBe('streamable-http')
  })

  it('imported records land disabled + unconfirmed; manual default enabled', () => {
    const imp = normalizeConnectorInput('a', { command: 'x' }, { provenance: 'import', now: NOW })
    expect(imp.enabled).toBe(false)
    expect(imp.pendingConfirmation).toBe(true)
    const man = normalizeConnectorInput('b', { command: 'x' }, { provenance: 'manual', now: NOW })
    expect(man.enabled).toBe(true)
    expect(man.pendingConfirmation).toBe(false)
  })

  it('malformed policy values are dropped, never coerced', () => {
    const rec = normalizeConnectorInput(
      'p',
      { command: 'x', permissionMode: 'allow-everything', toolPermissions: { good: 'allow', bad: 'Allow', worse: 'yes' } },
      { provenance: 'manual', now: NOW },
    )
    expect(rec.permissionMode).toBe('review-all')
    expect(rec.toolPermissions).toEqual({ good: 'allow' })
  })

  it('proto-unsafe keys in env are rejected', () => {
    // Built via JSON.parse because a JS object literal `{ __proto__: 'x' }`
    // sets the prototype instead of creating the own key a hostile import
    // would carry.
    const raw = JSON.parse('{"command":"x","env":{"__proto__":"x"}}')
    expect(() => normalizeConnectorInput('p', raw, { provenance: 'manual', now: NOW })).toThrowError(/invalid key/)
  })
})

describe('redaction boundaries', () => {
  const secret = normalizeConnectorInput(
    'cred',
    {
      url: 'https://api.example.com/mcp',
      authToken: 'super-secret-token-123',
      headers: { 'x-api-key': 'key-9876' },
    },
    { provenance: 'manual', now: NOW },
  )

  it('publicView carries no url, token, or header values', () => {
    const view = publicView(secret)
    expect(view.target).toBe('https://api.example.com')
    assertNoCredentialLeak(secret, view)
    expect(JSON.stringify(view)).not.toContain('super-secret-token-123')
    expect(JSON.stringify(view)).not.toContain('key-9876')
  })

  it('redactTarget shows command basename only for stdio', () => {
    const rec = normalizeConnectorInput('s', { command: '/usr/local/bin/npx' }, { provenance: 'manual', now: NOW })
    expect(redactTarget(rec)).toBe('npx')
  })

  it('MASK is fixed-length', () => {
    expect(MASK).toBe('********')
  })
})
