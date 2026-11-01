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

/**
 * `plainHttpAllowlist` is fed to BOTH seams on purpose: the write-time
 * normalize that seeds the records, and the bridge config the connect-time
 * judgement reads. A test that grants only one of them is testing a state the
 * plugin can never be in.
 */
function setup(records: Array<[string, Record<string, unknown>]>, sessionFactory?: SessionFactory, plainHttpAllowlist: string[] = []) {
  const io = memIo()
  const store = new RegistryStore(io, { dir: '/reg', now: () => NOW })
  store.load()
  for (const [id, raw] of records) {
    store.upsert(normalizeConnectorInput(id, raw, { provenance: 'manual', now: NOW, plainHttpAllowlist }))
  }
  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 1000, getPlainHttpAllowlist: () => plainHttpAllowlist }, sessionFactory)
  return { store, bridge, io }
}

/**
 * Scripted session: replays request results by method; initialize overridable.
 *
 * Keep this stub no more permissive than a real session: the real
 * `McpStdioSession.initialize()` used to return void, and because this fake
 * returned `{ serverName: 'fake' }` the missing identity stayed green for
 * eight releases. A stub that "works harder" than production hides the bug.
 */
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

/**
 * The connect-time plaintext gate.
 *
 * These cases seed the store DIRECTLY (bypassing `store.add`/import) because
 * that is the whole reason the gate moved into `McpBridge`: `store.load()`
 * asserts records out of registry.json without re-normalizing, so a hand-edited
 * row is exactly the shape that used to reach the network unjudged. If the
 * assertion below ever passes only because the seed path started validating,
 * the test has stopped testing the boundary — keep the seed raw.
 */
describe('McpBridge — plain http enforcement at connect time', () => {
  const LAN = 'http://192.168.1.23:8080/mcp'

  function seedRaw(allow: string[]): { store: RegistryStore; io: StoreFileIo; allow: string[] } {
    const io = memIo()
    const store = new RegistryStore(io, { dir: '/reg', now: () => NOW })
    store.load()
    const record = normalizeConnectorInput('lan', { url: LAN }, {
      provenance: 'manual',
      now: NOW,
      // Grant the write path so the row exists at all — the point under test is
      // what the CONNECT path decides, not whether the seed could be written.
      plainHttpAllowlist: allow,
    })
    store.upsert({ ...record, enabled: true, pendingConfirmation: false })
    return { store, io, allow }
  }

  it('refuses a non-loopback http row that the write check never saw, without touching the network', async () => {
    const { store } = seedRaw(['192.168.1.23'])
    // The stored row is real and enabled — prove the seed bypassed the rule.
    expect(store.get('lan')?.url).toBe(LAN)
    expect(store.get('lan')?.enabled).toBe(true)
    let spawned = 0
    // The bridge is configured with the OLD closed list: the row exists, the
    // grant does not. This is the hand-edited registry.json shape.
    const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 1000, getPlainHttpAllowlist: () => [] }, () => {
      spawned += 1
      return fakeSession({})
    })
    await expect(bridge.listTools('lan')).rejects.toThrow(/not granted/)
    // 'user' bypasses the authz policy gate but NOT the connect-time plaintext
    // gate — that is exactly the seam under test. An 'agent' + review-all call
    // would return needs_review before ever reaching getSession.
    await expect(bridge.callTool('lan', 'x', {}, 'user', 'review-all')).rejects.toThrow(/not granted/)
    const outcome = await bridge.probe('lan')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('http-plain-not-allowed')
    expect(outcome.message).toMatch(/plainHttpAllowlist/)
    expect(spawned).toBe(0)
  })

  it('grants all three paths once the host is allowlisted', async () => {
    const { store } = seedRaw(['192.168.1.23'])
    let spawned = 0
    const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 1000, getPlainHttpAllowlist: () => ['192.168.1.0/24'] }, () => {
      spawned += 1
      return fakeSession({ 'tools/list': () => ({ tools: [] }), 'tools/call': () => ({ content: [] }) })
    })
    await expect(bridge.listTools('lan')).resolves.toEqual([])
    const outcome = await bridge.callTool('lan', 'someTool', {}, 'user', 'allow-all')
    expect(outcome.status).toBe('executed')
    const probe = await bridge.probe('lan')
    expect(probe.ok).toBe(true)
    expect(spawned).toBeGreaterThan(0)
  })

  it('the never-plaintext floor is refused even when a CIDR entry covers it', async () => {
    const io = memIo()
    const store = new RegistryStore(io, { dir: '/reg', now: () => NOW })
    store.load()
    // Built from a loopback seed rather than normalize()ed with the real url:
    // the write path refuses a floor host unconditionally (that is the point),
    // so a floor row can only ever arrive via a hand-edited registry.json.
    const seed = normalizeConnectorInput('meta', { url: 'http://127.0.0.1:9/mcp' }, { provenance: 'manual', now: NOW })
    store.upsert({ ...seed, id: 'meta', url: 'http://169.254.169.254/latest/mcp', enabled: true, pendingConfirmation: false })
    let spawned = 0
    const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 1000, getPlainHttpAllowlist: () => ['169.254.0.0/16'] }, () => {
      spawned += 1
      return fakeSession({})
    })
    const outcome = await bridge.probe('meta')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('http-plain-forbidden')
    expect(spawned).toBe(0)
  })

  it('loopback and https rows never consult the allowlist', async () => {
    let spawned = 0
    const factory: SessionFactory = () => {
      spawned += 1
      return fakeSession({})
    }
    const { bridge } = setup(
      [['lb', { url: 'http://127.0.0.1:8080/mcp' }], ['sec', { url: 'https://api.example.com/mcp' }]],
      factory,
      [],
    )
    const a = await bridge.probe('lb')
    const b = await bridge.probe('sec')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(spawned).toBe(2)
  })
})
