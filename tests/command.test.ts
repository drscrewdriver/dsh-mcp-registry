import { describe, expect, it } from 'vitest'
import { registerMcpRegCommand } from '../src/surface/command.ts'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'
import { McpBridge } from '../src/bridge.ts'

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

function setup() {
  const io = memIo()
  const store = new RegistryStore(io, { dir: '/reg', now: () => 1_700_000_000_000 })
  store.load()
  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 500 })
  let handler: ((inv: { rawInput?: unknown }) => { kind: string; text: string }) | undefined
  registerMcpRegCommand({ commands: { register: (cmd: { handler: typeof handler }) => { handler = cmd.handler } } }, {
    store,
    bridge,
    getDefaultMode: () => 'review-all',
  })
  if (!handler) throw new Error('command did not register')
  const run = (input: string) => handler!({ rawInput: input })
  return { store, run }
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
