/**
 * McpBridge — the only code that turns a registry entry into live MCP calls.
 *
 * Three invariants:
 *  1. Every AGENT-initiated call routes through resolveToolAccess (authz.ts).
 *     The user-driven path (/mcp-reg call) is the human approving by the act
 *     of typing it, so it skips the policy gate but never the global/connector
 *     gates — and the choice is explicit at the call site, not inferred.
 *  2. The evidence side table (what the running server declared about each
 *     tool) lives in MEMORY ONLY. Persisting it would let a stale or
 *     hand-edited file authorize a tool the server no longer describes as
 *     read-only.
 *  3. Review is REFUSED HONESTLY. The DSH 0.1.7 host has no per-call approval
 *     chain for tools, so a 'review' verdict returns a structured needs_review
 *     result with grant instructions — it never executes and never pretends to
 *     have asked anyone.
 */
import { resolveToolAccess, mergeAnnotations, type AccessPolicy, type ToolAnnotations } from './authz.ts'
import type { ConnectorRecord, PermissionMode } from './core/model.ts'
import type { RegistryStore } from './core/store.ts'
import { McpHttpSession, type InitializeInfo } from './client/http-client.ts'
import { McpStdioSession } from './client/stdio-client.ts'
import { McpTransportError } from './client/transport-error.ts'

export interface BridgeConfig {
  getProbeTimeoutMs(): number
}

export interface SessionLike {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  initialize(timeoutMs: number): Promise<InitializeInfo | void>
  close(): void
}

export type SessionFactory = (record: ConnectorRecord) => SessionLike

export interface ToolListing {
  name: string
  description?: string
  annotations?: ToolAnnotations
}

export interface BridgeCallOutcome {
  ok: boolean
  status: 'executed' | 'needs_review' | 'refused'
  reason?: string
  hint?: string
  result?: unknown
}

interface ConnectorEvidence {
  listedAt: number
  tools: Map<string, ToolAnnotations>
}

const CALL_TIMEOUT_MS = 60_000

function defaultSessionFactory(record: ConnectorRecord): SessionLike {
  if (record.transport === 'streamable-http') {
    return new McpHttpSession(record.url, {
      headers: record.headers,
      authToken: record.authType === 'bearer' ? record.authToken : undefined,
      timeoutMs: 10_000,
    })
  }
  return new McpStdioSession({ command: record.command, args: record.args }, {
    cwd: record.cwd,
    env: record.env,
  })
}

export class McpBridge {
  private readonly store: RegistryStore
  private readonly config: BridgeConfig
  private readonly createSession: SessionFactory
  private readonly sessions = new Map<string, SessionLike>()
  private readonly evidence = new Map<string, ConnectorEvidence>()
  private probeInFlight = new Map<string, Promise<ProbeOutcome>>()
  /** Last probe outcome per connector — display cache only, never persisted. */
  readonly probeCache = new Map<string, ProbeOutcome>()

  constructor(store: RegistryStore, config: BridgeConfig, createSession: SessionFactory = defaultSessionFactory) {
    this.store = store
    this.config = config
    this.createSession = createSession
  }

  private getSession(record: ConnectorRecord): SessionLike {
    let session = this.sessions.get(record.id)
    if (!session) {
      session = this.createSession(record)
      this.sessions.set(record.id, session)
    }
    return session
  }

  private requireConnector(id: string): ConnectorRecord {
    const record = this.store.get(id)
    if (!record) throw new McpTransportError('unknown-connector', `no connector "${id}" in the registry`)
    if (!record.enabled) throw new McpTransportError('connector-disabled', `connector "${id}" is disabled`)
    if (record.pendingConfirmation) {
      throw new McpTransportError('pending-confirmation', `connector "${id}" was imported and still awaits human confirmation (mcp-reg confirm ${id})`)
    }
    return record
  }

  /** tools/list; refreshes the in-memory annotation evidence table. */
  async listTools(id: string): Promise<ToolListing[]> {
    const record = this.requireConnector(id)
    const session = this.getSession(record)
    const result = await session.request('tools/list', {}, Math.max(this.config.getProbeTimeoutMs(), 10_000))
    const tools = extractTools(result)
    const entry: ConnectorEvidence = { listedAt: Date.now(), tools: new Map() }
    for (const tool of tools) {
      entry.tools.set(tool.name, tool.annotations ?? {})
    }
    this.evidence.set(id, entry)
    return tools
  }

  /**
   * One MCP initialize against a THROWAWAY session. Honest outcome either
   * way: ok=false carries a stable failure code, never a guessed "healthy".
   * Single-flight per connector so a double click does not double-spawn.
   */
  probe(id: string): Promise<ProbeOutcome> {
    const inFlight = this.probeInFlight.get(id)
    if (inFlight) return inFlight
    const run = this.doProbe(id)
      .then((outcome) => {
        this.probeCache.set(id, outcome)
        return outcome
      })
      .finally(() => {
        this.probeInFlight.delete(id)
      })
    this.probeInFlight.set(id, run)
    return run
  }

  private async doProbe(id: string): Promise<ProbeOutcome> {
    const record = this.requireConnector(id)
    const started = Date.now()
    let session: SessionLike | null = null
    try {
      session = this.createSession(record)
      const info = await session.initialize(this.config.getProbeTimeoutMs())
      return {
        ok: true,
        latencyMs: Date.now() - started,
        at: Date.now(),
        protocolVersion: info?.protocolVersion,
        serverName: info?.serverName,
        serverVersion: info?.serverVersion,
      }
    } catch (e) {
      const err = e instanceof McpTransportError ? e : new McpTransportError('probe-failed', (e as Error).message)
      return { ok: false, code: err.code, message: err.message, latencyMs: Date.now() - started, at: Date.now() }
    } finally {
      session?.close()
    }
  }

  async callTool(
    id: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    via: 'agent' | 'user',
    defaultMode: PermissionMode,
  ): Promise<BridgeCallOutcome> {
    const record = this.requireConnector(id)
    // Normalize the tool name against a live listing when we have one; an
    // unknown tool with no listing still goes through the seam (rule 2 lets
    // explicit grants run), but with NO evidence side table.
    const annotations = this.evidence.get(id)?.tools.get(toolName)

    if (via === 'agent') {
      const policy: AccessPolicy = {
        permissionMode: record.permissionMode ?? defaultMode,
        toolPermission: record.toolPermissions[toolName],
        trustReadOnlyHint: record.trustReadOnlyHint,
      }
      const kind = resolveToolAccess(policy, { listed: this.evidence.has(id), annotations })
      if (kind === 'review') {
        return {
          ok: false,
          status: 'needs_review',
          reason: reviewReason(record, toolName, annotations),
          hint: `The connector owner can run: mcp-reg mode ${record.id} allowlist && mcp-reg grant ${record.id} ${toolName} — or call it themselves via mcp-reg call.`,
        }
      }
    }

    const session = this.getSession(record)
    const result = await session.request('tools/call', { name: toolName, arguments: args ?? {} }, CALL_TIMEOUT_MS)
    return { ok: true, status: 'executed', result }
  }

  evidenceAgeMs(id: string): number | undefined {
    const entry = this.evidence.get(id)
    return entry ? Date.now() - entry.listedAt : undefined
  }

  closeAll(): void {
    for (const [, session] of this.sessions) session.close()
    this.sessions.clear()
    this.evidence.clear()
    this.probeCache.clear()
    this.probeInFlight.clear()
  }

  /** Drop everything held for one connector: live session (stdio child
   *  process / http transport), evidence, probe cache, in-flight probe.
   *  Called on remove — without it a deleted id's child process would leak
   *  until plugin restart with no path left to close it. */
  forget(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      try { session.close() } catch { /* best effort */ }
      this.sessions.delete(id)
    }
    this.evidence.delete(id)
    this.probeCache.delete(id)
    this.probeInFlight.delete(id)
  }
}

export interface ProbeOutcome {
  ok: boolean
  latencyMs: number
  at: number
  code?: string
  message?: string
  protocolVersion?: string
  serverName?: string
  serverVersion?: string
}

function extractTools(result: unknown): ToolListing[] {
  if (result === null || typeof result !== 'object') return []
  const tools = (result as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  const out: ToolListing[] = []
  for (const raw of tools) {
    if (raw === null || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    if (typeof obj.name !== 'string' || !obj.name) continue
    const annotationsObj = obj.annotations
    const annotations: ToolAnnotations | undefined =
      annotationsObj && typeof annotationsObj === 'object' && !Array.isArray(annotationsObj)
        ? annotationsObj as ToolAnnotations
        : undefined
    out.push({
      name: obj.name,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      // Fresh listings REPLACE the previous annotations for this tool; the
      // merge guard only matters when two listings coexist mid-refresh.
      annotations: annotations ? mergeAnnotations(undefined, annotations) : undefined,
    })
  }
  return out
}

function reviewReason(
  record: ConnectorRecord,
  toolName: string,
  annotations: ToolAnnotations | undefined,
): string {
  if (record.permissionMode !== 'allowlist') {
    return `connector "${record.id}" is in review-all mode: every agent call needs an explicit decision`
  }
  if (annotations?.destructiveHint === true) {
    return `tool "${toolName}" is declared destructiveHint by its server — a known danger is never silently approved`
  }
  if (record.trustReadOnlyHint && annotations?.readOnlyHint !== true) {
    return `tool "${toolName}" has no live read-only declaration from the running server, and implicit trust requires fresh evidence`
  }
  return `tool "${toolName}" has no explicit grant for connector "${record.id}"`
}
