/**
 * /mcp-registry/api — the settings-card gateway.
 *
 * Faithful to the dsh-browser-cdp gateway pattern (src/gateway.ts): prefix
 * route on the optional webServer, POST-only, same-origin enforcement, JSON
 * envelope {ok, value|error:{code,message}}, bounded JSON body.
 *
 * These routes ARE the human console behind the settings card: every policy
 * mutation here is the /mcp-reg subcommand equivalent, triggered by an
 * explicit user click. Agents cannot reach them (they are HTTP-only, and no
 * agent tool maps to them). Responses carry redacted projections only — the
 * full endpoint URL / command line never crosses this boundary.
 */
import type { RegistryStore } from '../core/store.ts'
import { UnknownConnectorError, DamagedRegistryError } from '../core/store.ts'
import { publicView, redactTarget, McpRecordError, type PermissionMode } from '../core/model.ts'
import type { McpBridge } from '../bridge.ts'
import { McpTransportError } from '../client/transport-error.ts'
import { importMcpJson, McpImportError } from '../io/import.ts'
import { exportMcpJson } from '../io/export.ts'
import type { McpRegistryContext } from '../types.ts'

const API_PREFIX = '/mcp-registry/api'

interface EnvelopeOk<T> { ok: true; value: T }
interface EnvelopeError { ok: false; error: { code: string; message: string } }
type Envelope<T> = EnvelopeOk<T> | EnvelopeError

interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

function writeJson(res: ServerResponseLike, status: number, body: Envelope<unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function envelopeOk<T>(value: T): EnvelopeOk<T> {
  return { ok: true, value }
}

function envelopeError(code: string, message: string): EnvelopeError {
  return { ok: false, error: { code, message } }
}

async function readJsonBody(req: unknown, maxBytes = 262144): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req as AsyncIterable<Buffer | Uint8Array>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  return JSON.parse(text) as Record<string, unknown>
}

export interface GatewayDeps {
  store: RegistryStore
  bridge: McpBridge
  getEnabled(): boolean
}

export function registerMcpRegistryGateway(ctx: McpRegistryContext, deps: GatewayDeps): unknown {
  const webServer = ctx.get?.('webServer') as
    | { register?(opts: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void }
    | undefined
  if (!webServer || typeof webServer.register !== 'function') return undefined

  const { store, bridge } = deps

  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (reqRaw: unknown, resRaw: unknown): Promise<void> => {
      const res = resRaw as ServerResponseLike
      const req = reqRaw as { method?: string; headers: Record<string, unknown>; url?: string }
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, envelopeError('method-not-allowed', 'POST only'))
          return
        }
        // Same-origin only (CSRF gate): the Origin host must equal Host.
        const origin = req.headers.origin
        if (origin) {
          let originHost: string
          try {
            originHost = new URL(String(origin)).host
          } catch {
            writeJson(res, 400, envelopeError('invalid-origin', 'invalid Origin header'))
            return
          }
          if (!req.headers.host || originHost !== String(req.headers.host)) {
            writeJson(res, 403, envelopeError('origin-not-allowed', 'same-origin requests only'))
            return
          }
        }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, envelopeError('content-type-not-supported', 'application/json required'))
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : ''
        if (method === '' || method.includes('/')) {
          writeJson(res, 404, envelopeError('not-found', 'unknown mcp-registry API method'))
          return
        }
        const body = await readJsonBody(req)
        const id = typeof body.id === 'string' ? body.id : ''

        if (method === 'status') {
          if (store.isDamaged()) {
            writeJson(res, 200, envelopeOk({
              enabled: deps.getEnabled(),
              damaged: true,
              damageReason: store.damageReason,
              corruptFile: store.corruptFilePath,
              connectors: [],
            }))
            return
          }
          writeJson(res, 200, envelopeOk({
            enabled: deps.getEnabled(),
            connectors: store.list().map((c) => ({
              ...publicView(c),
              probe: bridge.probeCache.get(c.id) ?? null,
            })),
          }))
          return
        }

        if (method === 'probe') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          const outcome = await bridge.probe(id)
          writeJson(res, 200, envelopeOk({ outcome }))
          return
        }

        if (method === 'confirm' || method === 'enable' || method === 'disable') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          const record = method === 'confirm' ? store.confirm(id) : store.setEnabled(id, method === 'enable')
          writeJson(res, 200, envelopeOk({ connector: publicView(record) }))
          return
        }

        if (method === 'add') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          const connector = (body.connector && typeof body.connector === 'object' && !Array.isArray(body.connector))
            ? body.connector
            : body
          const record = store.add({ id: body.id, connector })
          writeJson(res, 200, envelopeOk({ connector: publicView(record) }))
          return
        }

        if (method === 'remove') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          store.remove(id)
          bridge.forget(id)
          writeJson(res, 200, envelopeOk({ removed: id }))
          return
        }

        if (method === 'tools') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          const tools = await bridge.listTools(id)
          writeJson(res, 200, envelopeOk({
            tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', annotations: t.annotations ?? {} })),
          }))
          return
        }

        if (method === 'policy') {
          if (!id) { writeJson(res, 400, envelopeError('invalid-id', 'id is required')); return }
          const patch: {
            permissionMode?: PermissionMode
            trustReadOnlyHint?: boolean
            toolPermissions?: Record<string, 'allow' | 'review'>
          } = {}
          if (body.permissionMode === 'review-all' || body.permissionMode === 'allowlist') {
            patch.permissionMode = body.permissionMode
          }
          if (typeof body.trustReadOnlyHint === 'boolean') patch.trustReadOnlyHint = body.trustReadOnlyHint
          if (body.toolPermissions && typeof body.toolPermissions === 'object' && !Array.isArray(body.toolPermissions)
            && Object.keys(body.toolPermissions).length > 0) {
            // Whole-map patch from the console panel: updatePolicy rebuilds
            // through safeAssign, so untrusted keys stay sanitized. Values
            // must already be valid enum strings — anything else is dropped
            // by the same normalization import uses.
            const map: Record<string, 'allow' | 'review'> = {}
            for (const [k, v] of Object.entries(body.toolPermissions as Record<string, unknown>)) {
              if ((v === 'allow' || v === 'review') && k.trim()) map[k.trim()] = v
            }
            patch.toolPermissions = map
          }
          if (typeof body.grant === 'string' && body.grant.trim()) {
            const current = store.get(id)
            const next: Record<string, 'allow' | 'review'> = { ...(current?.toolPermissions ?? {}) }
            next[body.grant.trim()] = 'allow'
            patch.toolPermissions = next
          }
          if (typeof body.revoke === 'string' && body.revoke.trim()) {
            const current = store.get(id)
            const next: Record<string, 'allow' | 'review'> = { ...(current?.toolPermissions ?? {}) }
            const target = body.revoke.trim()
            for (const key of Object.keys(next)) {
              if (key === target || target === '*') delete next[key]
            }
            patch.toolPermissions = next
          }
          const record = store.updatePolicy(id, patch)
          writeJson(res, 200, envelopeOk({ connector: publicView(record) }))
          return
        }

        if (method === 'import') {
          const json = typeof body.json === 'string' ? body.json : ''
          if (!json.trim()) { writeJson(res, 400, envelopeError('empty-json', 'json is required')); return }
          const { records } = importMcpJson(json, { now: Date.now() })
          for (const record of records) store.upsert(record)
          writeJson(res, 200, envelopeOk({
            imported: records.map((r) => ({ id: r.id, transport: r.transport, target: redactTarget(r) })),
          }))
          return
        }

        if (method === 'export') {
          writeJson(res, 200, envelopeOk({ json: exportMcpJson(store.list(), { includeSecrets: false }) }))
          return
        }

        if (method === 'call') {
          const tool = typeof body.tool === 'string' ? body.tool : ''
          if (!id || !tool) { writeJson(res, 400, envelopeError('invalid-args', 'id and tool are required')); return }
          const args = (body.args && typeof body.args === 'object' && !Array.isArray(body.args))
            ? body.args as Record<string, unknown>
            : {}
          const outcome = await bridge.callTool(id, tool, args, 'user', 'review-all')
          writeJson(res, 200, envelopeOk({ outcome }))
          return
        }

        writeJson(res, 404, envelopeError('not-found', `unknown mcp-registry API method "${method}"`))
      } catch (error) {
        if (error instanceof McpImportError) {
          writeJson(res, 400, envelopeError(`import-${error.code}`, `[${error.connectorId}] ${error.message}`))
          return
        }
        if (error instanceof UnknownConnectorError) {
          writeJson(res, 404, envelopeError('unknown-connector', error.message))
          return
        }
        if (error instanceof DamagedRegistryError) {
          writeJson(res, 409, envelopeError('registry-damaged', error.message))
          return
        }
        if (error instanceof McpRecordError) {
          writeJson(res, 400, envelopeError(error.code, error.message))
          return
        }
        if (error instanceof McpTransportError) {
          // disabled / pending-confirmation / unknown-connector / transport
          // failures are client-visible 4xx semantics, not server faults —
          // notably tools-listing on a fresh (disabled+pending) connector,
          // which is the NORM, not an edge case.
          const status = error.code === 'unknown-connector' ? 404 : 400
          writeJson(res, status, envelopeError(error.code, error.message))
          return
        }
        const e = error as { code?: string }
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, 500, envelopeError(e?.code || 'internal', message))
      }
    },
  })
  return dispose
}
