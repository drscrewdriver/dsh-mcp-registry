/**
 * MCP streamable-http client session.
 *
 * v1 semantics: lazily initialize once per session and reuse; on a 404 (the
 * session expired server-side) re-initialize once and retry once. Bearer auth
 * rides the Authorization header; a token never appears in an error message.
 */
import { makeNotification, makeRequest, isRpcResponse, rpcErrorMessage } from './jsonrpc.ts'
import { McpTransportError, describeFetchFailure, parseResponseBody } from './transport-error.ts'

export interface InitializeInfo {
  protocolVersion?: string
  serverName?: string
  serverVersion?: string
}

export interface McpHttpSessionOptions {
  headers?: Record<string, string>
  authToken?: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

const PROTOCOL_VERSION = '2024-11-05'

export class McpHttpSession {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private sessionId = ''
  private initialized = false
  private initializing: Promise<InitializeInfo> | null = null
  info: InitializeInfo = {}

  constructor(url: string, opts: McpHttpSessionOptions) {
    this.url = url
    this.timeoutMs = opts.timeoutMs
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...opts.headers,
    }
    if (opts.authToken) this.headers['authorization'] = `Bearer ${opts.authToken}`
  }

  /** Initialize (idempotent, single-flight). Returns honest server info. */
  initialize(): Promise<InitializeInfo> {
    if (this.initialized) return Promise.resolve(this.info)
    this.initializing ??= this.doInitialize().finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  private async doInitialize(): Promise<InitializeInfo> {
    const result = await this.post(makeRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-registry', version: '0.1.0' },
    }))
    const info: InitializeInfo = {}
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>
      if (typeof obj.protocolVersion === 'string') info.protocolVersion = obj.protocolVersion
      const serverInfo = obj.serverInfo
      if (serverInfo && typeof serverInfo === 'object') {
        const si = serverInfo as Record<string, unknown>
        if (typeof si.name === 'string') info.serverName = si.name
        if (typeof si.version === 'string') info.serverVersion = si.version
      }
    }
    this.info = info
    this.initialized = true
    // The initialized notification has no response; a failure here is not
    // fatal for stateless servers, so it is best-effort by design.
    try {
      await this.post(makeNotification('notifications/initialized'))
    } catch {
      /* ignore — documented */
    }
    return info
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.initialize()
    try {
      return await this.post(makeRequest(method, params))
    } catch (e) {
      // 404 after a successful init means the server dropped our session;
      // re-initialize once and retry once. Anything else propagates honestly.
      if (e instanceof McpTransportError && e.code === 'http-404') {
        this.initialized = false
        await this.initialize()
        return await this.post(makeRequest(method, params))
      }
      throw e
    }
  }

  /** v1 keeps no persistent resources; the seam exists for SessionLike parity. */
  close(): void {}

  private async post(message: unknown): Promise<unknown> {    const headers: Record<string, string> = { ...this.headers }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    let res: Response
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw describeFetchFailure(e)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (!res.ok) {
      // Body is not parsed on purpose: error bodies are server-controlled
      // text and must not flow into our error messages.
      throw new McpTransportError(`http-${res.status}`, `server answered HTTP ${res.status}`)
    }
    const text = await res.text()
    const body = parseResponseBody(text, res.headers.get('content-type') ?? '')
    // 202 Accepted with empty body: valid for notifications.
    if (body === undefined || body === null || body === '') return undefined
    if (!isRpcResponse(body)) throw new McpTransportError('bad-json', 'response is not a JSON-RPC response')
    if (body.error) throw new McpTransportError('rpc-error', rpcErrorMessage(body.error))
    return body.result
  }
}
