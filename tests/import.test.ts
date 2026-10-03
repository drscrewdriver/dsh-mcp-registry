import { describe, expect, it } from 'vitest'
import { importMcpJson } from '../src/io/import.ts'
import { exportMcpJson } from '../src/io/export.ts'
import { normalizeConnectorInput } from '../src/core/model.ts'

const NOW = 1_700_000_000_000
const imp = (text: string) => importMcpJson(text, { now: NOW })

describe('importMcpJson — the four bug-class rejections', () => {
  it('string args: loud error with the connector id, never a silent drop', () => {
    expect(() => imp(`{"mcpServers":{"a":{"command":"npx","args":"-y srv"}}}`))
      .toThrowError(/import\["a"\]|args must be a JSON array/)
  })

  it('non-string item in args: rejected', () => {
    expect(() => imp(`{"mcpServers":{"a":{"command":"npx","args":["-y",3]}}}`))
      .toThrowError(/args\[1\] is number/)
  })

  it('flattened command line with no args: rejected, never auto-split', () => {
    expect(() => imp(`{"mcpServers":{"a":{"command":"npx -y mcp-server"}}}`))
      .toThrowError(/command contains whitespace/)
  })

  it('proto pollution keys: the WHOLE import is rejected', () => {
    expect(() => imp(`{"mcpServers":{"a":{"command":"npx","env":{"__proto__":{"x":1}}}}}`))
      .toThrowError(/rejected entirely|invalid key/)
    // "constructor" as a connector id is a hostile payload key → whole import rejected.
    expect(() => imp(`{"mcpServers":{"constructor":{"command":"npx"}}}`)).toThrowError(/rejected entirely/)
  })

  it('invalid JSON and missing mcpServers name the problem', () => {
    expect(() => imp('{oops')).toThrowError(/not valid JSON/)
    expect(() => imp('{"servers":{}}')).toThrowError(/mcpServers/)
  })
})

describe('importMcpJson — happy path and defaults', () => {
  it('imports a standard Claude-style config, all disabled + unconfirmed + review-all', () => {
    const { records } = imp(JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        remote: { url: 'https://mcp.example.com/mcp' },
        'local-http': { url: 'http://127.0.0.1:3000/mcp' },
      },
    }))
    expect(records).toHaveLength(3)
    for (const record of records) {
      expect(record.enabled).toBe(false)
      expect(record.pendingConfirmation).toBe(true)
      expect(record.provenance).toBe('import')
      expect(record.permissionMode).toBe('review-all')
      expect(record.toolPermissions).toEqual({})
    }
    expect(records.find((r) => r.id === 'github')?.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(records.find((r) => r.id === 'remote')?.transport).toBe('streamable-http')
  })

  it('unknown fields are dropped, not carried into the record', () => {
    const { records } = imp(`{"mcpServers":{"a":{"command":"npx","isActive":true,"autoStart":false}}}`)
    expect(Object.keys(records[0] as object)).not.toContain('isActive')
  })
})

describe('exportMcpJson — redaction', () => {
  it('masks env/header values by default and never exports authToken', () => {
    const rec = normalizeConnectorInput(
      'cred',
      { url: 'http://127.0.0.1:9222/mcp', authToken: 'tok_abc123', headers: { 'x-key': 'k-42' }, env: undefined },
      { provenance: 'manual', now: NOW },
    )
    const out = exportMcpJson([rec])
    expect(out).not.toContain('tok_abc123')
    expect(out).toContain('********')
    const withSecrets = exportMcpJson([rec], { includeSecrets: true })
    expect(withSecrets).toContain('tok_abc123')
  })

  it('stdio round-trip preserves the args ARRAY exactly', () => {
    const rec = normalizeConnectorInput('gh', { command: 'npx', args: ['-y', 'srv'] }, { provenance: 'manual', now: NOW })
    const parsed = JSON.parse(exportMcpJson([rec])) as { mcpServers: Record<string, { command: string; args: string[] }> }
    expect(parsed.mcpServers.gh).toEqual({ command: 'npx', args: ['-y', 'srv'] })
  })
})
