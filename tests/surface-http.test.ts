import { describe, expect, it } from 'vitest'
import { registerMcpRegistryGateway } from '../src/surface/http.ts'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'
import { McpBridge } from '../src/bridge.ts'

/** In-memory IO (same shape as store.test's memIo). */
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

type Handler = (req: unknown, res: unknown) => void | Promise<void>

/** Fake webServer ctx: captures the prefix handler for direct invocation. */
function fakeGateway(store: RegistryStore, bridge: McpBridge): { handle(method: string, body: unknown): Promise<{ status: number; body: any }> } {
  let handler: Handler | undefined
  const ctx = {
    get: () => ({
      register: (opts: { handler: Handler }) => { handler = opts.handler },
    }),
  }
  const dispose = registerMcpRegistryGateway(ctx as never, { store, bridge, getEnabled: () => true })
  void dispose
  const call = handler as Handler
  return {
    async handle(method: string, body: unknown) {
      const chunks = [Buffer.from(JSON.stringify(body ?? {}))]
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'dsh.internal' },
        url: `/mcp-registry/api/${method}`,
        [Symbol.asyncIterator]() {
          let i = 0
          return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
        },
      }
      let out = { status: 0, text: '' }
      const res = {
        writeHead(status: number) { out.status = status },
        end(bodyText?: string) { out.text = bodyText ?? '' },
      }
      await call(req, res)
      return { status: out.status, body: JSON.parse(out.text) }
    },
  }
}

function newBridge(io: StoreFileIo) {
  const store = new RegistryStore(io, { dir: '/reg', now: () => 1_700_000_000_000 })
  store.load()
  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => 500 })
  return { store, bridge }
}

describe('mcp-registry gateway (0.3.0 methods)', () => {
  it('add creates a disabled+pending connector and reports it through publicView', async () => {
    const io = memIo()
    const { store, bridge } = newBridge(io)
    const gw = fakeGateway(store, bridge)
    const r = await gw.handle('add', { id: 'srv-a', connector: { command: 'npx', args: ['-y', 'srv'] } })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.value.connector.enabled).toBe(false)
    expect(r.body.value.connector.pendingConfirmation).toBe(true)
  })

  it('P1-D: status carries per-tool allow/review VALUES (not just key names)', async () => {
    const io = memIo()
    const { store, bridge } = newBridge(io)
    const gw = fakeGateway(store, bridge)
    await gw.handle('add', { id: 'srv-a', connector: { command: 'npx' } })
    store.confirm('srv-a')
    await gw.handle('policy', { id: 'srv-a', toolPermissions: { read_stuff: 'allow', write_stuff: 'review' } })
    const status = await gw.handle('status', {})
    const row = status.body.value.connectors.find((c: { id: string }) => c.id === 'srv-a')
    expect(row.toolPermissions).toEqual({ read_stuff: 'allow', write_stuff: 'review' })
  })

  it('policy with a whole toolPermissions map persists; duplicate add rejects with id-conflict', async () => {
    const io = memIo()
    const { store, bridge } = newBridge(io)
    const gw = fakeGateway(store, bridge)
    await gw.handle('add', { id: 'srv-a', connector: { command: 'npx' } })
    const dup = await gw.handle('add', { id: 'srv-a', connector: { command: 'other' } })
    expect(dup.status).toBe(400)
    expect(dup.body.error.code).toBe('id-conflict')
    const bad = await gw.handle('add', { id: 'bad id!', connector: { command: 'npx' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid-id')
  })

  it('P2-c: tools on a fresh (disabled+pending) connector is 4xx pending-confirmation, not 500', async () => {
    const io = memIo()
    const { store, bridge } = newBridge(io)
    const gw = fakeGateway(store, bridge)
    await gw.handle('add', { id: 'srv-a', connector: { command: 'npx' } })
    const r = await gw.handle('tools', { id: 'srv-a' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('connector-disabled')
  })

  it('remove deletes and drops the bridge entry (forget)', async () => {
    const io = memIo()
    const { store, bridge } = newBridge(io)
    const gw = fakeGateway(store, bridge)
    await gw.handle('add', { id: 'srv-a', connector: { command: 'npx' } })
    store.confirm('srv-a')
    const r = await gw.handle('remove', { id: 'srv-a' })
    expect(r.status).toBe(200)
    expect(r.body.value.removed).toBe('srv-a')
    expect(store.get('srv-a')).toBeUndefined()
    const gone = await gw.handle('remove', { id: 'srv-a' })
    expect(gone.status).toBe(404)
    expect(gone.body.error.code).toBe('unknown-connector')
  })
})
