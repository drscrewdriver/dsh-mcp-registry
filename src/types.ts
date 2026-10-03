/**
 * dsh-mcp-registry — shared host-side types.
 *
 * Self-contained structural types for the DSH host services this plugin
 * consumes (tools / commands / webServer / provide). We deliberately do NOT
 * import from `@deepseek-ai/cordis`: the ctx shape is matched structurally so
 * the package typechecks without a cordis install (same approach as
 * dsh-browser-cdp/src/types.ts).
 */

/** Reader over the exec identity a tool call carries. */
export interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

export type ToolExecute = (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown> | unknown

export interface ToolRegistrar {
  register(tool: unknown): unknown
}

export interface LoggerLike {
  (id: string): LoggerLike | undefined
  info(message: unknown, ...args: unknown[]): void
  warn(message: unknown, ...args: unknown[]): void
  error(message: unknown, ...args: unknown[]): void
}

/** /mcp-reg command invocation (loose: the host contract is host-declared). */
export interface CommandInvocation {
  rawInput?: unknown
}

export interface CommandsService {
  register(cmd: {
    name: string
    description: string
    input?: unknown
    handler: (invocation: CommandInvocation) => unknown
  }): unknown
}

export interface RouteHandler {
  (req: unknown, res: unknown): void
}

export interface WebServerLike {
  get?(path: string, handler: RouteHandler): unknown
  register?(opts: { kind: string; path: string; handler: RouteHandler }): () => void
}

/** Host context shape the plugin consumes (structural; not imported from cordis). */
export interface McpRegistryContext {
  tools: ToolRegistrar
  logger?: LoggerLike
  commands?: CommandsService
  webServer?: WebServerLike
  get?(name: string): unknown
  provide?(name: string, surface: unknown): unknown
  effect?(fn: () => unknown, label?: string): unknown
  on?(event: string, fn: (...args: unknown[]) => unknown): () => void
}

/** Raw composition-layer config (volatile fields arrive as live references). */
export interface RawConfig {
  enabled?: unknown
  defaultPermissionMode?: unknown
  probeTimeoutMs?: unknown
  [key: string]: unknown
}
