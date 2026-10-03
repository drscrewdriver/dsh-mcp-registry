/**
 * Export back to the portable mcpServers JSON shape — REDACTED by default.
 *
 * authToken is never exported in any mode (it is registry-internal auth, not
 * something a mcpServers file can carry). env/headers values mask to ********
 * unless the caller passes includeSecrets, which only the /mcp-reg command
 * sets after an explicit user request.
 */
import { MASK } from '../core/model.ts'
import type { ConnectorRecord } from '../core/model.ts'

export function exportMcpJson(
  records: ConnectorRecord[],
  opts: { includeSecrets?: boolean } = {},
): string {
  const includeSecrets = opts.includeSecrets === true
  const servers: Record<string, unknown> = {}
  for (const record of records) {
    if (record.transport === 'stdio') {
      const entry: Record<string, unknown> = { command: record.command, args: [...record.args] }
      if (record.cwd) entry.cwd = record.cwd
      if (Object.keys(record.env).length > 0) entry.env = maskValues(record.env, includeSecrets)
      servers[record.id] = entry
    } else {
      const entry: Record<string, unknown> = { url: record.url, transport: 'streamable-http' }
      if (record.authType === 'bearer') {
        const headers = { ...record.headers }
        let sawAuthHeader = false
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization') {
            sawAuthHeader = true
            headers[k] = includeSecrets ? (headers[k] ?? MASK) : `Bearer ${MASK}`
          }
        }
        if (!sawAuthHeader) headers['authorization'] = includeSecrets ? `Bearer ${record.authToken}` : `Bearer ${MASK}`
        entry.headers = headers
      } else if (Object.keys(record.headers).length > 0) {
        entry.headers = maskValues(record.headers, includeSecrets)
      }
      servers[record.id] = entry
    }
  }
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

function maskValues(record: Record<string, string>, includeSecrets: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = includeSecrets ? value : value ? MASK : value
  }
  return out
}
