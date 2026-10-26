import { describe, expect, it } from 'vitest'
import { registerMcpRegCommand } from '../src/surface/command.ts'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'
import { McpBridge, type SessionFactory } from '../src/bridge.ts'

function memIo() {
  const files = new Map<string, string>()
  const io: StoreFileIo = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, data) => void files.set(p, data),
    rename: (src, dst) => {
      const content = files.get(src)
      if (content === undefined) throw new Error(`rename source missing: ${src}`)
      files.delete(src)
      files.set(dst, content)
    },
    rmIfExists: (p) => void files.delete(p),
    mkdirp: () => {},
    listDir: (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    rm: (p) => void files.delete(p),
    exists: (p) => files.has(p),
  }
  return io
}

type RawHandler = (inv: { rawInput?: unknown }) => unknown

function setup(sessionFactory?: SessionFactory) {
  const io = memIo()
  const store = new RegistryStore(io, { dir: '/reg', now: () => 1_700_000_000_000 })
  store.load()
  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 500 }, sessionFactory)
  let handler: RawHandler | undefined
  registerMcpRegCommand({ commands: { register: (cmd: { handler: RawHandler }) => { handler = cmd.handler } } }, {
    store,
    bridge,
    getDefaultMode: () => 'review-all',
  })
  if (!handler) throw new Error('command did not register')
  // `run` keeps the original text-only assertions working; `runRaw` hands the
  // UNNARROWED return value to the contract-parity suite — narrowing here would
  // reintroduce exactly the blind spot that hid the `kind: 'text'` bug.
  const runRaw: RawHandler = (inv) => handler!(inv)
  const run = (input: string) => handler!({ rawInput: input }) as { kind: string; text?: string }
  return { store, run, runRaw }
}

describe('mcp-reg CLI add/remove (0.3.0)', () => {
  it('add creates disabled+pending; usage and JSON errors are plain text', () => {
    const { store, run } = setup()
    expect(run('add').text).toContain('usage')
    expect(run('add not-json').text).toContain('not valid JSON')
    expect(run('add {"command":"npx"}').text).toContain('"id" is required')
    const out = run('add {"id":"srv-a","command":"npx","args":["-y","srv"]}')
    expect(out.text).toContain('disabled + unconfirmed')
    const rec = store.get('srv-a')
    expect(rec?.enabled).toBe(false)
    expect(rec?.pendingConfirmation).toBe(true)
    expect(run('add {"id":"srv-a","command":"other"}').text).toContain('already exists')
  })

  it('remove deletes and reports; unknown id surfaces the error', () => {
    const { store, run } = setup()
    store.add({ id: 'srv-a', connector: { command: 'npx' } })
    expect(run('remove srv-a').text).toContain('removed')
    expect(store.get('srv-a')).toBeUndefined()
    expect(run('remove srv-a').text).toContain('unknown connector')
  })
})

/**
 * Verbatim port of the host's `normalizeResult`
 * (deepseek-harness packages/interaction/commands/src/index.ts) — the registry
 * boundary that killed `/mcp-reg` on real hosts for 8 releases. Asserting on
 * `.text` alone cannot catch a contract drift, because a hand-rolled
 * `{ register(cmd) { handler = cmd.handler } }` mock never runs this check.
 * Keep the three throw texts word-for-word aligned with the host.
 */
function hostNormalize(command: string, value: unknown) {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`)
  }
  const result = value as { kind?: unknown; text?: unknown }
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`command "${command}" success text must be a string when supplied`)
    }
    return result as { kind: 'success'; text?: string }
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`command "${command}" error text must be a non-empty string`)
    }
    return result as { kind: 'error'; text: string }
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`)
}

describe('host contract parity (0.3.10)', () => {
  it('success paths return kind "success" (never the legacy "text") and pass the host normalizer', async () => {
    const { runRaw } = setup()
    // Note: usage/precondition failures are plain TEXT from dispatch (a success
    // result), not thrown. Only genuine exceptions reach the `error` branch.
    for (const input of [
      'help',
      'list',
      'export',
      'add {"id":"srv-b","command":"npx"}',
      'add not-json',
      'remove srv-missing',
      'unknown-subcommand',
    ]) {
      const raw = await Promise.resolve(runRaw({ rawInput: input }))
      const normalized = hostNormalize('mcp-reg', raw)
      expect(normalized.kind).toBe('success')
      if (raw && typeof raw === 'object' && 'text' in raw) {
        expect(typeof (raw as { text?: unknown }).text === 'string').toBe(true)
      }
    }
  })

  it('error paths carry non-empty text so the host does not throw a second time', async () => {
    const { runRaw } = setup()
    // `import <missing path>` is the reachable exception path: readFileSync throws
    // ENOENT inside dispatch, which lands in the handler catch -> kind: 'error'.
    const missing = `${process.cwd()}/__no_such_mcp_registry_file__.json`
    for (const input of [`import ${missing}`, `import ${process.cwd()}`]) {
      const raw = await Promise.resolve(runRaw({ rawInput: input }))
      const normalized = hostNormalize('mcp-reg', raw)
      expect(normalized.kind).toBe('error')
      expect((normalized as { text: string }).text.trim().length).toBeGreaterThan(0)
    }
  })

  it('the async probe branch satisfies the same contract', async () => {
    const { runRaw } = setup(() => ({
      request: async () => ({ tools: [] }),
      initialize: async () => ({ protocolVersion: '2024-11-05', serverName: 'stub', serverVersion: '1.2.3' }),
      close: () => {},
    }))
    const add = await Promise.resolve(runRaw({ rawInput: 'add {"id":"srv-p","command":"npx"}' }))
    hostNormalize('mcp-reg', add)
    const confirm = await Promise.resolve(runRaw({ rawInput: 'confirm srv-p' }))
    hostNormalize('mcp-reg', confirm)
    const probed = await Promise.resolve(runRaw({ rawInput: 'probe srv-p' }))
    const normalized = hostNormalize('mcp-reg', probed)
    expect(normalized.kind).toBe('success')
    expect((normalized as { text?: string }).text).toContain('stub')
  })
})
