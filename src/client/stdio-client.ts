/**
 * MCP stdio client: spawn(command, args[], { shell: false }) + newline-
 * delimited JSON-RPC over the pipes.
 *
 * The Windows half is a faithful port of openhanako's core/mcp/clients/
 * stdio-client.ts:247-368, because those ~120 lines encode every way a
 * cross-platform spawn silently fails:
 *  - `npx`/`uvx` are .cmd shims on Windows: spawn needs cmd.exe /d /s /c with
 *    each argument re-quoted (% doubled, quotes escaped) or the child never
 *    sees the args it was promised;
 *  - PATH is case-insensitive on Windows (Path/PATH), extensions come from
 *    PATHEXT, and a bare command name must be resolved before spawning;
 *  - `shell: false` + array args is the injection boundary — the only place a
 *    joined command line is ever built is the cmd.exe wrap below, where every
 *    argument goes through quoteWin32CmdArg.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { makeNotification, makeRequest, isRpcResponse, rpcErrorMessage } from './jsonrpc.ts'
import { McpTransportError } from './transport-error.ts'

export interface StdioProcessLike {
  stdin: { write(data: string): void; end(): void }
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void }
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void }
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void
  kill(): void
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; shell: false; windowsHide: boolean },
) => StdioProcessLike

// ── Windows command resolution (pure, injectable, directly unit-tested) ────

function win32PathDirs(env: NodeJS.ProcessEnv): string[] {
  const pathKey = Object.keys(env ?? {}).find((key) => key.toLowerCase() === 'path')
  const raw = pathKey ? String(env[pathKey] ?? '') : ''
  return raw.split(';').map((entry) => entry.trim()).filter(Boolean)
}

function win32PathExts(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env ?? {}).find((item) => item.toLowerCase() === 'pathext')
  const raw = key ? String(env[key] ?? '') : '.COM;.EXE;.BAT;.CMD'
  const values = raw.split(';').map((entry) => entry.trim()).filter(Boolean)
  return values.length ? values : ['.COM', '.EXE', '.BAT', '.CMD']
}

function win32Comspec(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env ?? {}).find((item) => item.toLowerCase() === 'comspec')
  return key && env[key] ? String(env[key]) : 'cmd.exe'
}

function isBareWin32Command(command: string): boolean {
  const raw = command.trim()
  return !!raw && !/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw)
}

function isWin32CmdShim(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command)
}

function isWin32Executable(command: string): boolean {
  return /\.exe$/i.test(command)
}

/** Quote one argument for a cmd.exe /c command line. */
export function quoteWin32CmdArg(value: string): string {
  const text = String(value ?? '')
  if (text.length === 0) return '""'
  if (!/[\s"&|<>^()%]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

/** The ONLY place command + args are ever joined, and always space-separated. */
export function buildWin32CmdLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteWin32CmdArg).join(' ')
}

export interface ResolvedWin32Command {
  command: string
  needsCmd: boolean
}

export function resolveWin32PathCommand(
  raw: string,
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): string {
  if (!raw) return ''
  const hasPath = /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)
  const dot = raw.lastIndexOf('.')
  const ext = dot > raw.lastIndexOf('/') && dot > raw.lastIndexOf('\\') ? raw.slice(dot) : ''
  const pathext = win32PathExts(env)
  const candidates = ext ? [raw] : [raw, ...pathext.map((suffix) => `${raw}${suffix}`)]
  if (hasPath) {
    return candidates.find((candidate) => existsSync(candidate)) ?? ''
  }
  for (const dir of win32PathDirs(env)) {
    for (const candidate of candidates) {
      const full = `${dir}\\${candidate}`
      if (existsSync(full)) return full
    }
  }
  return ''
}

export function resolveWin32Command(
  command: string,
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): ResolvedWin32Command {
  const resolved = resolveWin32PathCommand(command, env, existsSync)
  const effective = resolved || command
  if (isWin32CmdShim(effective)) return { command: effective, needsCmd: true }
  if (isWin32Executable(effective)) return { command: effective, needsCmd: false }
  if (isBareWin32Command(command)) return { command: effective, needsCmd: true }
  return { command: effective, needsCmd: false }
}

export interface StdioSpawnSpec {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Build the final spawn(command, args) pair for the current platform. */
export function resolveStdioSpawnSpec(
  record: { command: string; args: readonly string[]; cwd?: string; env?: Record<string, string> },
  opts: { platform: string; baseEnv?: NodeJS.ProcessEnv; existsSync?: (path: string) => boolean },
): StdioSpawnSpec {
  const command = String(record.command || '').trim()
  const args = [...record.args]
  const baseEnv = opts.baseEnv ?? process.env
  const env = { ...baseEnv, ...record.env }
  if (opts.platform !== 'win32') return { command, args, env }
  const existsSync = opts.existsSync ?? (() => false)
  const resolved = resolveWin32Command(command, env, existsSync)
  if (!resolved.needsCmd) return { command: resolved.command, args, env }
  return {
    command: win32Comspec(env),
    args: ['/d', '/s', '/c', buildWin32CmdLine(resolved.command, args)],
    env,
  }
}

// ── The session ─────────────────────────────────────────────────────────────

const STDERR_TAIL_BYTES = 8 * 1024

interface Pending {
  resolve: (value: unknown) => void
  reject: (e: McpTransportError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface StdioSessionOptions {
  cwd?: string
  env?: Record<string, string>
  platform?: string
  baseEnv?: NodeJS.ProcessEnv
  existsSync?: (path: string) => boolean
  spawnFn?: SpawnFn
}

export class McpStdioSession {
  private readonly record: { command: string; args: readonly string[] }
  private readonly opts: StdioSessionOptions
  private process: StdioProcessLike | null = null
  private buffer = ''
  private stderrTail = ''
  private pending = new Map<number, Pending>()
  private exited: string | null = null
  info: { serverName?: string; serverVersion?: string; protocolVersion?: string } = {}

  constructor(record: { command: string; args: readonly string[] }, opts: StdioSessionOptions = {}) {
    this.record = record
    this.opts = opts
  }

  private ensureStarted(): StdioProcessLike {
    if (this.process) return this.process
    const spec = resolveStdioSpawnSpec(
      { command: this.record.command, args: this.record.args, cwd: this.opts.cwd, env: this.opts.env },
      { platform: this.opts.platform ?? process.platform, baseEnv: this.opts.baseEnv, existsSync: this.opts.existsSync },
    )
    const spawnFn = this.opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn)
    const child = spawnFn(spec.command, spec.args, {
      cwd: this.opts.cwd || undefined,
      env: spec.env,
      shell: false,
      windowsHide: true,
    })
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.on('data', (chunk) => this.onStderr(chunk))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    this.process = child
    return child
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return // not JSON: some servers print banners; ignore, honest errors surface via stderr tail
    }
    if (!isRpcResponse(msg)) return
    if (typeof msg.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new McpTransportError('rpc-error', rpcErrorMessage(msg.error)))
    else entry.resolve(msg.result)
  }

  private onStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES)
  }

  private onExit(code: number | null, signal: string | null): void {
    this.exited = `process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    this.process = null
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      const tail = this.stderrTail.trim().slice(-400)
      entry.reject(new McpTransportError('process-exited', `${this.exited}${tail ? `; stderr: ${tail}` : ''}`))
      this.pending.delete(id)
    }
  }

  async initialize(timeoutMs: number): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-registry', version: '0.1.0' },
    }, timeoutMs)
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>
      if (typeof obj.protocolVersion === 'string') this.info.protocolVersion = obj.protocolVersion
      const si = obj.serverInfo
      if (si && typeof si === 'object') {
        const serverInfo = si as Record<string, unknown>
        if (typeof serverInfo.name === 'string') this.info.serverName = serverInfo.name
        if (typeof serverInfo.version === 'string') this.info.serverVersion = serverInfo.version
      }
    }
    this.sendNotification(makeNotification('notifications/initialized'))
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const child = this.ensureStarted()
    if (this.exited) throw new McpTransportError('process-exited', this.exited)
    const req = makeRequest(method, params)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id)
        reject(new McpTransportError('timeout', `${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(req.id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify(req) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(req.id)
        reject(new McpTransportError('stdin-failed', `failed to write to child stdin: ${(e as Error).message}`))
      }
    })
  }

  private sendNotification(note: ReturnType<typeof makeNotification>): void {
    const child = this.ensureStarted()
    try {
      child.stdin.write(JSON.stringify(note) + '\n')
    } catch {
      /* best-effort, same as the http initialized notification */
    }
  }

  stderrTailForDiagnostics(): string {
    return this.stderrTail.trim().slice(-400)
  }

  close(): void {
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    if (this.process) {
      try {
        this.process.kill()
      } catch {
        /* already dead */
      }
      this.process = null
    }
  }
}
