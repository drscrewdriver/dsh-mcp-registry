import { describe, expect, it } from 'vitest'
import { RegistryStore, UnknownConnectorError, type StoreFileIo } from '../src/core/store.ts'

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
  return { io, files }
}

const NOW = 1_700_000_000_000
function newStore(io: StoreFileIo, dir = '/reg') {
  const store = new RegistryStore(io, { dir, now: () => NOW })
  store.load()
  return store
}

describe('RegistryStore.add / remove (0.3.0)', () => {
  it('P0-1: manual add lands DISABLED + PENDING regardless of normalized defaults', () => {
    const { io } = memIo()
    const store = newStore(io)
    // body carries neither enabled nor pendingConfirmation — the model's
    // manual-provenance defaults would land enabled+confirmed; the store must
    // override both (two guard rails of bridge.requireConnector stay shut).
    const rec = store.add({ id: 'srv-a', connector: { command: 'npx', args: ['-y', 'srv'] } })
    expect(rec.enabled).toBe(false)
    expect(rec.pendingConfirmation).toBe(true)
    expect(rec.provenance).toBe('manual')
    // Even if the caller tries to smuggle enabled:true past the body.
    const rec2 = store.add({ id: 'srv-b', connector: { command: 'npx', enabled: true, pendingConfirmation: false } })
    expect(rec2.enabled).toBe(false)
    expect(rec2.pendingConfirmation).toBe(true)
  })

  it('P1-A: id required, sanitized; a conflicting id is REJECTED and the existing record untouched', () => {
    const { io } = memIo()
    const store = newStore(io)
    const first = store.add({ id: 'srv-a', connector: { command: 'npx' } })
    store.updatePolicy('srv-a', { toolPermissions: { t1: 'allow' }, permissionMode: 'allowlist' })

    expect(() => store.add({ id: 'bad id!', connector: { command: 'npx' } })).toThrow(/not a valid id/)
    expect(() => store.add({ id: 'srv-a', connector: { command: 'other' } })).toThrow(/already exists/)
    // The existing record kept its policy (no silent replace).
    const after = store.get('srv-a')
    expect(after?.toolPermissions).toEqual({ t1: 'allow' })
    expect(after?.permissionMode).toBe('allowlist')
    expect(after?.command).toBe('npx')
    void first
  })

  it('remove deletes and persists; unknown id throws UnknownConnectorError', () => {
    const { io } = memIo()
    const store = newStore(io)
    store.add({ id: 'srv-a', connector: { command: 'npx' } })
    expect(store.remove('srv-a')).toBe('srv-a')
    expect(store.get('srv-a')).toBeUndefined()
    expect(() => store.remove('srv-a')).toThrow(UnknownConnectorError)
    // Removal survived a reload from disk.
    const second = newStore(io)
    expect(second.get('srv-a')).toBeUndefined()
  })

  it('damaged registry refuses add/remove', () => {
    const { io, files } = memIo()
    files.set('/reg/registry.json', '{not json')
    const store = newStore(io)
    expect(store.isDamaged()).toBe(true)
    expect(() => store.add({ id: 'x', connector: { command: 'npx' } })).toThrow(/fail-closed/)
    expect(() => store.remove('x')).toThrow(/fail-closed/)
  })
})
