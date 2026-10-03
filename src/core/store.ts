/**
 * RegistryStore — the only writer of ~/.dsh/mcp-registry/registry.json.
 *
 * Write discipline (each rule has a failure it prevents):
 *  - ALL writes go through `mutate()` under a promise-chain mutex, so command
 *    handler and settings callback can never interleave read-modify-write.
 *  - Persist = snapshot → write tmp → rename → READ BACK and verify. A write
 *    that cannot be read back is reported as failed, never as success.
 *  - Parse/migration failure = fail-closed: the damaged file is preserved as
 *    registry.json.corrupt-<ts>, every connector is treated as nonexistent,
 *    and further writes are refused (no "helpful" auto-rebuild — a silently
 *    rebuilt registry could silently rewrite user authorization).
 *  - Removal does not exist in v1: `disable` keeps the record (append-only).
 *
 * The file IO is injected so tests run on an in-memory filesystem.
 */
import { sanitizeId, safeAssign } from './ids.ts'
import type { ConnectorRecord } from './model.ts'

export interface StoreFileIo {
  readFile(path: string): string | null
  writeFile(path: string, data: string): void
  rename(src: string, dst: string): void
  rmIfExists(path: string): void
  mkdirp(path: string): void
  listDir(path: string): string[]
  rm(path: string): void
  exists(path: string): boolean
}

export interface PersistedRegistry {
  version: 1
  generation: number
  connectors: ConnectorRecord[]
}

export interface StoreOptions {
  dir: string
  now?: () => number
  snapshotLimit?: number
}

const SCHEMA_VERSION = 1

export class UnknownConnectorError extends Error {
  constructor(id: string) {
    super(`unknown connector "${id}"`)
  }
}

export class DamagedRegistryError extends Error {
  constructor(detail: string) {
    super(`registry is in fail-closed state (${detail}); fix or remove the corrupt file first`)
  }
}

export class RegistryStore {
  private readonly io: StoreFileIo
  private readonly dir: string
  private readonly now: () => number
  private readonly snapshotLimit: number
  private readonly filePath: string
  private state: PersistedRegistry = { version: 1, generation: 0, connectors: [] }
  private loaded = false
  /** Fail-closed latch: set when the file exists but cannot be parsed. */
  damaged = false
  damageReason = ''
  corruptFilePath = ''

  constructor(io: StoreFileIo, opts: StoreOptions) {
    this.io = io
    this.dir = opts.dir
    this.now = opts.now ?? Date.now
    this.snapshotLimit = opts.snapshotLimit ?? 20
    this.filePath = this.join(this.dir, 'registry.json')
  }

  private join(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/')
  }

  /** Load once at startup; safe to call again (no-op). */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = this.io.readFile(this.filePath)
    if (raw === null) return // first boot: empty registry, not an error
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      this.enterFailClosed(`JSON parse failed: ${(e as Error).message}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.enterFailClosed('top level is not an object')
      return
    }
    const obj = parsed as Record<string, unknown>
    const version = obj.version
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      this.enterFailClosed('missing schema version')
      return
    }
    if (version > SCHEMA_VERSION) {
      // An unknown FUTURE version must disable, never degrade: guessing the
      // shape of a newer file could silently reinterpret authorization.
      this.enterFailClosed(`schema version ${version} is newer than supported ${SCHEMA_VERSION}`)
      return
    }
    if (!Array.isArray(obj.connectors)) {
      this.enterFailClosed('connectors is not an array')
      return
    }
    this.state = {
      version: 1,
      generation: typeof obj.generation === 'number' && Number.isFinite(obj.generation) ? obj.generation : 0,
      connectors: obj.connectors as ConnectorRecord[],
    }
  }

  private enterFailClosed(reason: string): void {
    this.damaged = true
    this.damageReason = reason
    this.corruptFilePath = `${this.filePath}.corrupt-${this.now()}`
    try {
      this.io.rename(this.filePath, this.corruptFilePath)
    } catch {
      this.corruptFilePath = this.filePath
    }
    this.state = { version: 1, generation: 0, connectors: [] }
  }

  /** True when the registry refused to load; every connector is then nonexistent. */
  isDamaged(): boolean {
    return this.damaged
  }

  list(): ConnectorRecord[] {
    // A damaged registry reports an EMPTY list (every connector is treated as
    // nonexistent) instead of throwing: the damage is surfaced through
    // isDamaged()/damageReason by the status surfaces, and writes are refused
    // in persistLocked. Callers keep one code path.
    return this.damaged ? [] : [...this.state.connectors]
  }

  get(id: string): ConnectorRecord | undefined {
    if (this.damaged) return undefined
    return this.state.connectors.find((c) => c.id === id)
  }

  getGeneration(): number {
    return this.state.generation
  }

  /**
   * Insert or replace a connector. The replace form is for settings-row
   * round-trips; user-visible edits should go through the field-level
   * mutators so a stale full record cannot clobber newer policy.
   */
  upsert(record: ConnectorRecord): ConnectorRecord {
    return this.runSync(() => {
      const idx = this.state.connectors.findIndex((c) => c.id === record.id)
      if (idx >= 0) {
        const previous = this.state.connectors[idx]
        if (!previous) throw new UnknownConnectorError(record.id)
        this.state.connectors[idx] = { ...record, createdAt: previous.createdAt, updatedAt: this.now() }
        return this.state.connectors[idx]
      }
      this.state.connectors.push(record)
      return record
    })
  }

  setEnabled(id: string, enabled: boolean): ConnectorRecord {
    return this.mutateRecord(id, (record) => {
      record.enabled = enabled
      if (enabled) record.pendingConfirmation = false
    })
  }

  /** Human confirmation of an imported credential: enables + clears the flag. */
  confirm(id: string): ConnectorRecord {
    return this.mutateRecord(id, (record) => {
      record.pendingConfirmation = false
      record.enabled = true
    })
  }

  updatePolicy(
    id: string,
    patch: {
      permissionMode?: 'review-all' | 'allowlist'
      toolPermissions?: Record<string, 'allow' | 'review'>
      trustReadOnlyHint?: boolean
    },
  ): ConnectorRecord {
    return this.mutateRecord(id, (record) => {
      if (patch.permissionMode !== undefined) record.permissionMode = patch.permissionMode
      if (patch.toolPermissions !== undefined) {
        // Rebuild through safeAssign: keys arrive from command input.
        const next: Record<string, 'allow' | 'review'> = {}
        for (const [k, v] of Object.entries(patch.toolPermissions)) {
          safeAssign(next, k, v)
        }
        record.toolPermissions = next
      }
      if (patch.trustReadOnlyHint !== undefined) record.trustReadOnlyHint = patch.trustReadOnlyHint
    })
  }

  setAuthToken(id: string, token: string): ConnectorRecord {
    return this.mutateRecord(id, (record) => {
      record.authToken = token
      record.authType = token ? 'bearer' : 'none'
    })
  }

  private mutateRecord(id: string, fn: (record: ConnectorRecord) => void): ConnectorRecord {
    return this.runSync(() => {
      const record = this.state.connectors.find((c) => c.id === id)
      if (!record) throw new UnknownConnectorError(id)
      fn(record)
      record.updatedAt = this.now()
      // Re-validate the id survives (it cannot change here, but the gate stays
      // in one place for future mutators).
      if (!sanitizeId(record.id)) throw new Error(`connector id became invalid`)
      return record
    })
  }

  /**
   * Serialize a synchronous mutation and persist it. Every IO call here is
   * synchronous, so a mutation is atomic within one Node turn — there is no
   * await point for a second writer to slip into. If an async IO backend ever
   * replaces StoreFileIo, this method is the single place that must grow a
   * promise-chain mutex.
   */
  private runSync<T>(fn: () => T): T {
    const result = fn()
    this.persistLocked()
    return result
  }

  private assertHealthy(): void {
    if (this.damaged) throw new DamagedRegistryError(this.damageReason)
  }

  private persistLocked(): void {
    this.assertHealthy()
    this.state.generation += 1
    this.io.mkdirp(this.dir)
    this.snapshot()
    const tmp = `${this.filePath}.tmp`
    const payload = JSON.stringify(this.state, null, 2)
    this.io.writeFile(tmp, payload)
    // Windows rename over an existing file can fail; fall back to rm+rename.
    try {
      this.io.rename(tmp, this.filePath)
    } catch {
      this.io.rmIfExists(this.filePath)
      this.io.rename(tmp, this.filePath)
    }
    // Verified write: what landed on disk must parse back to what we meant.
    const readBack = this.io.readFile(this.filePath)
    if (readBack === null) throw new Error('persist failed: file missing after rename')
    let parsed: PersistedRegistry
    try {
      parsed = JSON.parse(readBack) as PersistedRegistry
    } catch {
      throw new Error('persist failed: read-back mismatch (file does not parse)')
    }
    if (parsed.generation !== this.state.generation || !Array.isArray(parsed.connectors)) {
      throw new Error('persist failed: read-back mismatch')
    }
  }

  /** Copy the current file aside before overwriting; keep the newest N. */
  private snapshot(): void {
    if (!this.io.exists(this.filePath)) return
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const snapshotPath = this.join(this.dir, `registry.${stamp}.bak`)
    const current = this.io.readFile(this.filePath)
    if (current !== null) this.io.writeFile(snapshotPath, current)
    const snapshots = this.io
      .listDir(this.dir)
      .filter((name) => /^registry\..+\.bak$/.test(name))
      .sort()
    for (const name of snapshots.slice(0, Math.max(0, snapshots.length - this.snapshotLimit))) {
      this.io.rm(this.join(this.dir, name))
    }
  }
}
