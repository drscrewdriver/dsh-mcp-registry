import { describe, expect, it } from 'vitest'
import { McpBridge, type SessionFactory, type SessionLike } from '../src/bridge.ts'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'
import { normalizeConnectorInput } from '../src/core/model.ts'

const NOW = 1_700_000_000_000

function memIo(): StoreFileIo {
  const files = new Map<string, string>()
  return {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, d) => void files.set(p, d),
    rename: (s, d) => {
      const c = files.get(s)
      if (c === undefined) throw new Error('missing')
      files.delete(s)
      files.set(d, c)
    },
    rmIfExists: (p) => void files.delete(p),
    mkdirp: () => {},
    listDir: () => [],
    rm: (p) => void files.delete(p),
    exists: (p) => files.has(p),
  }
}

function setup(records: Array<[string, Record<string, unknown>]>, sessionFactory?: SessionFactory) {
  const io = memIo()
  const store = new RegistryStore(io, { dir: '/reg', now: () => NOW })
  store.load()
  for (const [id, raw] of records) {
    store.upsert(normalizeConnectorInput(id, raw, { provenance: 'manual', now: NOW }))
  }
  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 1000 }, sessionFactory)
  return { store, bridge }
}

/** Scripted session: replays request results by method; initialize overridable. */
function fakeSession(script: Partial<Record<string, (params: unknown) => unknown>>): SessionLike {
  return {
    request: async (method) => {
      const responder = script[method]
      if (!responder) throw new Error(`unexpected method ${method}`)
      return responder(undefined)
    },
    initialize: script.initialize
      ? (async () => {
          const responder = script.initialize
          if (!responder) throw new Error('unreachable')
          const out = responder(undefined)
          if (out instanceof Error) throw out
          return out as { protocolVersion?: string; serverName?: string }
        }) as SessionLike['initialize']
      : async () => ({ protocolVersion: '2024-11-05', serverName: 'fake' }),
    close: () => {},
  }
}

const STDIO = { command: 'npx', args: ['-y', 'srv'] }

describe('McpBridge — the review-first call path', () => {
  it('review-all connector: agent call REFUSES with needs_review and never executes', async () => {
    let executed = false
    const { bridge } = setup(
      [['srv', STDIO]],
      () => fakeSession({ 'tools/call': () => { executed = true; return {} } }),
    )
    const outcome = await bridge.callTool('srv', 'ping', {}, 'agent', 'review-all')
    expect(outcome.status).toBe('needs_review')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('review-all')
    expect(executed).toBe(false)
  })

  it('after a grant the agent call executes through the seam', async () => {
    const { store, bridge } = setup(
      [['srv', { ...STDIO, permissionMode: 'allowlist' }]],
      () => fakeSession({ 'tools/call': () => ({ content: [{ type: 'text', text: 'pong' }] }) }),
    )
    store.updatePolicy('srv', { toolPermissions: { ping: 'allow' } })
    const outcome = await bridge.callTool('srv', 'ping', {}, 'agent', 'review-all')
    expect(outcome.status).toBe('executed')
    expect(outcome.ok).toBe(true)
  })

  it('allowlist without a grant and without evidence stays review (fail-closed)', async () => {
    const { bridge } = setup([['srv', { ...STDIO, permissionMode: 'allowlist' }]], () => fakeSession({}))
    const outcome = await bridge.callTool('srv', 'anything', {}, 'agent', 'review-all')
    expect(outcome.status).toBe('needs_review')
  })

  it('a destructive tool is refused even with an explicit allow', async () => {
    const { store, bridge } = setup(
      [['srv', { ...STDIO, permissionMode: 'allowlist', toolPermissions: { dropAll: 'allow' } }]],
      () => fakeSession({ 'tools/list': () => ({ tools: [{ name: 'dropAll', annotations: { destructiveHint: true } }] }) }),
    )
    await bridge.listTools('srv') // live listing lands in the evidence table
    const outcome = await bridge.callTool('srv', 'dropAll', {}, 'agent', 'review-all')
    expect(outcome.status).toBe('needs_review')
    expect(outcome.reason).toContain('destructive')
    expect(store.get('srv')?.toolPermissions['dropAll']).toBe('allow') // the grant still exists — the veto outranks it
  })

  it('trustReadOnlyHint allows only against a LIVE read-only declaration', async () => {
    const { store, bridge } = setup(
      [['srv', { ...STDIO, permissionMode: 'allowlist', trustReadOnlyHint: true }]],
      () => fakeSession({
        'tools/list': () => ({ tools: [{ name: 'read', annotations: { readOnlyHint: true } }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: 'done' }] }),
      }),
    )
    const before = await bridge.callTool('srv', 'read', {}, 'agent', 'review-all')
    expect(before.status).toBe('needs_review') // no evidence yet
    await bridge.listTools('srv')
    const after = await bridge.callTool('srv', 'read', {}, 'agent', 'review-all')
    expect(after.status).toBe('executed')
    store.updatePolicy('srv', { trustReadOnlyHint: true })
  })

  it('the USER path bypasses the policy gate but not the connector gates', async () => {
    let executed = false
    const { bridge, store } = setup(
      [['srv', STDIO]],
      () => fakeSession({ 'tools/call': () => { executed = true; return { content: [] } } }),
    )
    const outcome = await bridge.callTool('srv', 'ping', {}, 'user', 'review-all')
    expect(outcome.status).toBe('executed')
    expect(executed).toBe(true)
    // ...but a disabled connector refuses even the user path.
    store.setEnabled('srv', false)
    await expect(bridge.callTool('srv', 'ping', {}, 'user', 'review-all')).rejects.toThrow(/disabled/)
  })

  it('probe is honest: failure carries a code, success carries server info', async () => {
    const { bridge } = setup(
      [['down', STDIO]],
      () => fakeSession({ initialize: () => new Error('boom') }),
    )
    const bad = await bridge.probe('down')
    expect(bad.ok).toBe(false)
    expect(bad.code).toBeTruthy()
    const { bridge: bridge2 } = setup([['up', STDIO]], () => fakeSession({}))
    const good = await bridge2.probe('up')
    expect(good.ok).toBe(true)
    expect(good.serverName).toBe('fake')
    expect(bridge2.probeCache.get('up')?.ok).toBe(true)
  })

  it('unknown and disabled connectors are refused before any IO', async () => {
    const { bridge } = setup([['srv', { ...STDIO, enabled: false }]], () => fakeSession({}))
    await expect(bridge.callTool('nope', 'x', {}, 'agent', 'review-all')).rejects.toThrow(/no connector/)
    await expect(bridge.listTools('srv')).rejects.toThrow(/disabled/)
  })
})
