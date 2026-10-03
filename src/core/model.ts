/**
 * ConnectorRecord — the persisted shape of one registered MCP connector, plus
 * the single normalization gate every value passes before it may touch disk.
 *
 * Design rules baked in here (each one is a lesson from the research corpus):
 *  - `args` is ALWAYS a string array, end to end. A string-typed `args` in an
 *    import is rejected LOUDLY — openhanako's mcp-config silently dropped it
 *    (arrayOfStrings returns [] for non-arrays) and the server then failed to
 *    start for no stated reason.
 *  - A `command` containing whitespace with no args is rejected, never
 *    auto-split: guessing the split is how `-y mcp-server` glue bugs are born.
 *  - Unknown/malformed policy values are DROPPED, never coerced: a malformed
 *    value must never widen access (openhanako manager.ts:129-140).
 *  - Every cross-boundary read goes through publicView/redactTarget: the full
 *    URL or command line is an RCE-grade credential.
 */
import { sanitizeId, safeAssign, isUnsafeKey } from './ids.ts'

export type ConnectorTransport = 'stdio' | 'streamable-http'
export type PermissionMode = 'review-all' | 'allowlist'
export type ToolPermission = 'allow' | 'review'
export type Provenance = 'manual' | 'import'

export interface ConnectorRecord {
  id: string
  name: string
  transport: ConnectorTransport
  /** streamable-http only; '' for stdio. */
  url: string
  /** stdio only; '' for remote. */
  command: string
  /** stdio only; ALWAYS a string array — never flattened, never joined. */
  args: string[]
  cwd: string
  env: Record<string, string>
  headers: Record<string, string>
  authType: 'none' | 'bearer'
  authToken: string
  enabled: boolean
  pendingConfirmation: boolean
  provenance: Provenance
  permissionMode: PermissionMode
  toolPermissions: Record<string, ToolPermission>
  trustReadOnlyHint: boolean
  createdAt: number
  updatedAt: number
  schemaVersion: 1
}

/** Error carrying a stable code so UIs can translate without parsing prose. */
export class McpRecordError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const MASK = '********'

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const PERMISSION_MODES = new Set<string>(['review-all', 'allowlist'])
const TOOL_PERMISSIONS = new Set<string>(['allow', 'review'])

const CAP = {
  id: 64,
  name: 128,
  url: 2048,
  command: 512,
  arg: 512,
  argsCount: 64,
  envEntries: 64,
  envValue: 4096,
  headerEntries: 64,
  token: 4096,
  toolName: 256,
} as const

export function normalizePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value) ? (value as PermissionMode) : 'review-all'
}

/** Unknown values → undefined (caller falls back to the strictest default). */
export function normalizeToolPermission(value: unknown): ToolPermission | undefined {
  return typeof value === 'string' && TOOL_PERMISSIONS.has(value) ? (value as ToolPermission) : undefined
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Hostname of a URL string, or '' when unparseable. */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Redacted target for display: origin only for http, basename for stdio. */
export function redactTarget(record: Pick<ConnectorRecord, 'transport' | 'url' | 'command'>): string {
  if (record.transport === 'streamable-http') {
    try {
      return new URL(record.url).origin
    } catch {
      return MASK
    }
  }
  const base = record.command.split(/[\\/]/).pop() || MASK
  return base
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringRecord(
  value: unknown,
  keyPattern: RegExp,
  errPrefix: string,
): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpRecordError('record-not-object', `${errPrefix} must be an object`)
  }
  const source = value as Record<string, unknown>
  const entries = Object.keys(source)
  if (entries.length > CAP.envEntries) {
    throw new McpRecordError('too-many-entries', `${errPrefix} exceeds ${CAP.envEntries} entries`)
  }
  const out: Record<string, string> = {}
  for (const key of entries) {
    if (isUnsafeKey(key) || !keyPattern.test(key)) {
      throw new McpRecordError('invalid-key', `${errPrefix} has an invalid key: ${JSON.stringify(key.slice(0, 32))}`)
    }
    const val = source[key]
    if (typeof val !== 'string') {
      throw new McpRecordError('value-not-string', `${errPrefix}.${key} must be a string`)
    }
    if (val.length > CAP.envValue) {
      throw new McpRecordError('value-too-long', `${errPrefix}.${key} exceeds ${CAP.envValue} chars`)
    }
    safeAssign(out, key, val)
  }
  return out
}

/**
 * Normalize one raw connector value (settings row or import entry) into a
 * ConnectorRecord. Throws McpRecordError with a stable code on any malformed
 * input — this function NEVER silently drops or repairs user data.
 */
export function normalizeConnectorInput(
  id: unknown,
  raw: unknown,
  opts: { provenance: Provenance; now: number },
): ConnectorRecord {
  const safeId = sanitizeId(id)
  if (!safeId) {
    throw new McpRecordError('invalid-id', `connector id ${JSON.stringify(String(id ?? '').slice(0, 32))} is not a valid id ([a-zA-Z0-9_-]{1,64})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpRecordError('not-an-object', `connector "${safeId}" must be an object`)
  }
  const rawRec = raw as Record<string, unknown>

  // ── transport detection (before field validation so errors name it) ────
  const url = str(rawRec.url)
  const command = str(rawRec.command)
  const typeRaw = str(rawRec.transport) || str(rawRec.type)
  let transport: ConnectorTransport
  if (typeRaw === 'stdio') transport = 'stdio'
  else if (
    typeRaw === 'streamable-http' || typeRaw === 'streamableHttp' || typeRaw === 'streamable-http'
    || typeRaw === 'sse' || typeRaw === 'http' || typeRaw === 'remote'
  ) {
    // Legacy sse/remote spellings normalize onto streamable-http; the connect
    // path reports an honest failure when the server does not speak it.
    transport = 'streamable-http'
  } else if (url) transport = 'streamable-http'
  else if (command) transport = 'stdio'
  else {
    throw new McpRecordError('no-target', `connector "${safeId}" has neither url nor command`)
  }

  // ── args: THE bug guard. Array-only, loud otherwise. ────────────────────
  let args: string[] = []
  if (rawRec.args !== undefined && rawRec.args !== null) {
    if (!Array.isArray(rawRec.args)) {
      throw new McpRecordError(
        'args-not-array',
        `connector "${safeId}": args must be a JSON array of strings (got ${Array.isArray(rawRec.args) ? 'array' : typeof rawRec.args}). `
        + 'A string like "-y mcp-server" is rejected because splitting it silently is how glued-args bugs are born — split it into ["-y", "mcp-server"].',
      )
    }
    if (rawRec.args.length > CAP.argsCount) {
      throw new McpRecordError('too-many-args', `connector "${safeId}": args exceeds ${CAP.argsCount} entries`)
    }
    args = rawRec.args.map((item, i) => {
      if (typeof item !== 'string') {
        throw new McpRecordError('args-non-string', `connector "${safeId}": args[${i}] is ${typeof item}, expected string`)
      }
      if (item.length > CAP.arg) {
        throw new McpRecordError('arg-too-long', `connector "${safeId}": args[${i}] exceeds ${CAP.arg} chars`)
      }
      return item
    })
  }

  // ── target validation per transport ────────────────────────────────────
  let finalUrl = ''
  let finalCommand = ''
  if (transport === 'streamable-http') {
    if (!url) throw new McpRecordError('missing-url', `connector "${safeId}" is missing url`)
    if (url.length > CAP.url) throw new McpRecordError('url-too-long', `connector "${safeId}": url exceeds ${CAP.url} chars`)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new McpRecordError('invalid-url', `connector "${safeId}": url does not parse`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new McpRecordError('url-scheme', `connector "${safeId}": only http/https urls are supported`)
    }
    // dsh-mcp-connector's default: HTTPS anywhere, plain HTTP loopback only.
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      throw new McpRecordError('http-non-loopback', `connector "${safeId}": plain http is only allowed for loopback hosts; use https for ${parsed.hostname}`)
    }
    finalUrl = url
  } else {
    if (!command) throw new McpRecordError('missing-command', `connector "${safeId}" is missing command`)
    if (command.length > CAP.command) throw new McpRecordError('command-too-long', `connector "${safeId}": command exceeds ${CAP.command} chars`)
    if (/\s/.test(command) && args.length === 0) {
      throw new McpRecordError(
        'command-has-whitespace',
        `connector "${safeId}": command contains whitespace and args is empty. Put the executable in command and each argument in the args array — e.g. {"command": "npx", "args": ["-y", "mcp-server-example"]}.`,
      )
    }
    finalCommand = command
  }

  // ── policy block: whitelist, drop unknowns, never widen ────────────────
  const toolPermissions: Record<string, ToolPermission> = {}
  if (rawRec.toolPermissions !== undefined && rawRec.toolPermissions !== null) {
    if (typeof rawRec.toolPermissions !== 'object' || Array.isArray(rawRec.toolPermissions)) {
      throw new McpRecordError('policy-not-object', `connector "${safeId}": toolPermissions must be an object`)
    }
    for (const [toolName, perm] of Object.entries(rawRec.toolPermissions as Record<string, unknown>)) {
      if (!toolName || toolName.length > CAP.toolName) continue
      const normalized = normalizeToolPermission(perm)
      // Malformed values are skipped, not coerced: keeping one would leave a
      // grant nobody can read back out of the UI, and guessing one wider
      // would widen access.
      if (normalized === undefined) continue
      safeAssign(toolPermissions, toolName, normalized)
    }
  }

  const authToken = str(rawRec.authToken) || str(rawRec.authorizationToken)
  if (authToken.length > CAP.token) {
    throw new McpRecordError('token-too-long', `connector "${safeId}": auth token exceeds ${CAP.token} chars`)
  }
  const authTypeRaw = str(rawRec.authType)
  const authType = authTypeRaw === 'bearer' || authToken ? 'bearer' : 'none'

  const env = stringRecord(rawRec.env, ENV_KEY, `connector "${safeId}" env`)
  const headers = stringRecord(rawRec.headers, HEADER_KEY, `connector "${safeId}" headers`)

  const name = str(rawRec.name) || safeId
  if (name.length > CAP.name) throw new McpRecordError('name-too-long', `connector "${safeId}": name exceeds ${CAP.name} chars`)

  return {
    id: safeId,
    name,
    transport,
    url: finalUrl,
    command: finalCommand,
    args,
    cwd: str(rawRec.cwd),
    env,
    headers,
    authType,
    authToken,
    // Import semantics differ from connector semantics: an imported entry is a
    // submitted CREDENTIAL until a human confirms it, so it lands disabled.
    enabled: opts.provenance === 'import' ? rawRec.enabled === true : rawRec.enabled !== false,
    pendingConfirmation: opts.provenance === 'import' ? true : rawRec.pendingConfirmation === true,
    provenance: opts.provenance,
    permissionMode: normalizePermissionMode(rawRec.permissionMode),
    toolPermissions,
    trustReadOnlyHint: rawRec.trustReadOnlyHint === true,
    createdAt: opts.now,
    updatedAt: opts.now,
    schemaVersion: 1,
  }
}

/** The only shape a non-authorized reader ever sees. No url, no command line, no env. */
export interface ConnectorPublicView {
  id: string
  name: string
  transport: ConnectorTransport
  target: string
  enabled: boolean
  pendingConfirmation: boolean
  provenance: Provenance
  permissionMode: PermissionMode
  grantedTools: string[]
  trustReadOnlyHint: boolean
}

export function publicView(record: ConnectorRecord): ConnectorPublicView {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    target: redactTarget(record),
    enabled: record.enabled,
    pendingConfirmation: record.pendingConfirmation,
    provenance: record.provenance,
    permissionMode: record.permissionMode,
    grantedTools: Object.keys(record.toolPermissions).filter((k) => record.toolPermissions[k] !== undefined),
    trustReadOnlyHint: record.trustReadOnlyHint,
  }
}
