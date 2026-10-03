/**
 * mcpServers JSON import — the fail-loud gate.
 *
 * This module exists because of a real bug class: openhanako's mcp-config
 * accepted `"args": "-y mcp-server"` (a string) and silently dropped it
 * (arrayOfStrings → []), so the server failed to start for no stated reason;
 * and a `"command": "npx -y mcp-server"` flattening is how glued-args bugs
 * (`-ymcp-server`) are born. Every malformed shape here is REJECTED with the
 * connector id and a fix hint. Nothing is dropped, nothing is auto-split.
 *
 * Any single malformed entry aborts the WHOLE import (fail-closed, loudest
 * option): a partial import that silently skips entries invites the user to
 * believe everything they pasted is now registered.
 */
import { hasUnsafeKeyDeep } from '../core/ids.ts'
import { normalizeConnectorInput, type ConnectorRecord, type Provenance } from '../core/model.ts'

export class McpImportError extends Error {
  readonly connectorId: string
  readonly code: string
  constructor(connectorId: string, code: string, message: string) {
    super(message)
    this.connectorId = connectorId
    this.code = code
  }
}

export interface ImportOutcome {
  records: ConnectorRecord[]
}

export function importMcpJson(
  text: string,
  opts: { now: number; provenance?: Provenance },
): ImportOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new McpImportError('*', 'invalid-json', `input is not valid JSON: ${(e as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpImportError('*', 'not-an-object', 'MCP JSON must be an object like {"mcpServers": {"<id>": {...}}}')
  }
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (servers === undefined || servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new McpImportError('*', 'missing-mcpServers', 'MCP JSON must contain a "mcpServers" object')
  }
  // One hostile key anywhere in the payload rejects the whole import: proto
  // pollution is not a per-entry problem, it is an "input is hostile" signal.
  if (hasUnsafeKeyDeep(servers)) {
    throw new McpImportError('*', 'proto-pollution', 'input contains __proto__/constructor/prototype keys — rejected entirely')
  }
  const entries = Object.entries(servers as Record<string, unknown>)
  if (entries.length === 0) {
    throw new McpImportError('*', 'empty', 'mcpServers is empty — nothing to import')
  }
  const records = entries.map(([id, raw]) =>
    normalizeConnectorInput(id, raw, { provenance: opts.provenance ?? 'import', now: opts.now }),
  )
  return { records }
}
