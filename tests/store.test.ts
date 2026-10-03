import { describe, expect, it } from 'vitest'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'
import { normalizeConnectorInput } from '../src/core/model.ts'

/** In-memory IO with rename simulation (rename overwrites the target). */
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
  return { io, files }
}

const NOW = 1_700_000_000_000

function record(id: string, overrides: Record<string, unknown> = {}) {
  return normalizeConnectorInput(id, { command: 'npx', args: ['-y', 'srv'], ...overrides }, { provenance: 'manual', now: NOW })
}

function newStore(io: StoreFileIo, dir = '/reg') {
  const store = new RegistryStore(io, { dir, now: () => NOW })
  store.load()
  return store
}

describe('RegistryStore', () => {
  it('first boot on a missing file is an empty registry, not an error', () => {
    const { io } = memIo()
    const store = newStore(io)
    expect(store.list()).toEqual([])
    expect(store.isDamaged()).toBe(false)
  })

  it('upsert persists and can be reloaded by a second store instance', () => {
    const { io } = memIo()
    const store = newStore(io)
    store.upsert(record('alpha'))
    expect(store.get('alpha')?.command).toBe('npx')

    const store2 = newStore(io)
    expect(store2.get('alpha')?.args).toEqual(['-y', 'srv'])
    expect(store2.getGeneration()).toBe(store.getGeneration())
  })

  it('write is verified by read-back: a corrupted backend surfaces the failure', () => {
    const { io, files } = memIo()
    const originalWrite = io.writeFile
    let tamper = false
    io.writeFile = (p, data) => {
      originalWrite(p, data)
      if (tamper && p.endsWith('.tmp')) files.set(p, '{"broken":')
    }
    const store = newStore(io)
    tamper = true
    expect(() => store.upsert(record('beta'))).toThrow(/read-back mismatch/)
    tamper = false
    store.upsert(record('gamma'))
    expect(store.get('gamma')).toBeDefined()
  })

  it('a corrupt registry file fails closed: no connectors, damaged flag, corrupt copy preserved', () => {
    const { io, files } = memIo()
    files.set('/reg/registry.json', '{"version":1, "connectors": [ BROKEN')
    const store = newStore(io)
    expect(store.isDamaged()).toBe(true)
    expect(store.damageReason).toContain('JSON parse failed')
    expect(store.list()).toEqual([])
    expect(store.corruptFilePath).toMatch(/^\/reg\/registry\.json\.corrupt-\d+$/)
    expect(files.has(store.corruptFilePath)).toBe(true)
    expect(files.has('/reg/registry.json')).toBe(false)
  })

  it('a future schema version fails closed instead of degrading', () => {
    const { io } = memIo()
    io.writeFile('/reg/registry.json', JSON.stringify({ version: 2, connectors: [] }))
    const store = newStore(io)
    expect(store.isDamaged()).toBe(true)
    expect(store.damageReason).toContain('newer than supported')
  })

  it('damaged registry refuses writes', () => {
    const { io } = memIo()
    io.writeFile('/reg/registry.json', 'not json at all')
    const store = newStore(io)
    expect(() => store.upsert(record('x'))).toThrow(/fail-closed/)
  })

  it('snapshots accumulate and prune to the limit', () => {
    let tick = 0
    const { io } = memIo()
    const store = new RegistryStore(io, { dir: '/reg', snapshotLimit: 3, now: () => NOW + tick++ })
    store.load()
    for (const id of ['a', 'b', 'c', 'd', 'e']) store.upsert(record(id))
    const snapshots = io.listDir('/reg').filter((n) => /^registry\..+\.bak$/.test(n))
    expect(snapshots.length).toBeLessThanOrEqual(3)
  })

  it('generation increments on every successful write', () => {
    const { io } = memIo()
    const store = newStore(io)
    const g0 = store.getGeneration()
    store.upsert(record('a'))
    store.setEnabled('a', false)
    expect(store.getGeneration()).toBe(g0 + 2)
    expect(store.get('a')?.enabled).toBe(false)
  })

  it('confirm enables and clears the pending flag; unknown ids throw', () => {
    const { io } = memIo()
    const store = newStore(io)
    store.upsert(record('imp', { enabled: false, pendingConfirmation: true }))
    store.confirm('imp')
    expect(store.get('imp')?.enabled).toBe(true)
    expect(store.get('imp')?.pendingConfirmation).toBe(false)
    expect(() => store.setEnabled('nope', true)).toThrow(/unknown connector/)
  })
})
