/**
 * /mcp-reg — the human operator console. Every registry WRITE lives behind
 * this command (or the settings page); agents have no writable path.
 *
 * Guarded registration (typeof ctx.commands?.register === 'function') so a
 * host without the commands service degrades to the agent tools only — the
 * same pattern dsh-preset-manager and dsh-session-guard use.
 *
 * Known boundary: `probe` and `call` return a Promise from the handler. Hosts
 * that await command handlers render the outcome; a strictly-sync host would
 * render nothing for those two subcommands (documented in HANDOVER.md).
 */
import { readFileSync } from 'node:fs'
import { publicView, redactTarget, type ConnectorRecord, type PermissionMode } from '../core/model.ts'
import type { RegistryStore } from '../core/store.ts'
import { UnknownConnectorError } from '../core/store.ts'
import type { McpBridge } from '../bridge.ts'
import { importMcpJson, McpImportError } from '../io/import.ts'
import { exportMcpJson } from '../io/export.ts'

export interface McpRegDeps {
  store: RegistryStore
  bridge: McpBridge
  getDefaultMode(): PermissionMode
}

const HELP = `mcp-reg — MCP connector registry console

  mcp-reg list                       list connectors (redacted)
  mcp-reg probe <id>                 run one MCP initialize handshake
  mcp-reg add <json>                 create ONE connector ({ "id": "...", ...fields });
                                     lands disabled + unconfirmed, like import
  mcp-reg remove <id>                delete a connector (drops its bridge session)
  mcp-reg import <path|json>         import mcpServers JSON (lands disabled + unconfirmed)
  mcp-reg export [--secrets]         export mcpServers JSON (secrets masked unless --secrets)
  mcp-reg confirm <id>               confirm an imported connector and enable it
  mcp-reg enable|disable <id>        flip the enabled switch
  mcp-reg mode <id> <review-all|allowlist>   set the permission mode
  mcp-reg grant <id> <tool|*>        allow a tool (or all) for agent calls
  mcp-reg revoke <id> <tool|*>       drop tool grants (back to review)
  mcp-reg trust <id> <on|off>        trust the server's readOnlyHint for ungranted tools
  mcp-reg call <id> <tool> [json]    call a tool as the USER (counts as approval)
  mcp-reg help                       this text`

interface CommandResult {
  kind: 'text' | 'error'
  text: string
}

export function registerMcpRegCommand(ctx: { commands?: { register(cmd: unknown): unknown } }, deps: McpRegDeps): unknown {
  if (typeof ctx.commands?.register !== 'function') return undefined
  return ctx.commands.register({
    name: 'mcp-reg',
    description:
      'MCP connector registry console: list/probe/import/export connectors, set permission mode, grant tools, '
      + 'and call tools as the user. Run `mcp-reg help` for subcommands.',
    input: { hint: '<list|probe|import|export|confirm|enable|disable|mode|grant|revoke|trust|call|help> ...' },
    handler: (invocation: { rawInput?: unknown }) => {
      const text = String(invocation?.rawInput ?? '').trim()
      let outcome: string | Promise<string>
      try {
        outcome = dispatch(text, deps)
      } catch (e) {
        return { kind: 'error', text: `mcp-reg failed: ${errorMessage(e)}` }
      }
      if (!(outcome instanceof Promise)) return { kind: 'text', text: outcome }
      return outcome.then(
        (text) => ({ kind: 'text', text }) satisfies CommandResult,
        (e: unknown) => ({ kind: 'error', text: `mcp-reg failed: ${errorMessage(e)}` }) satisfies CommandResult,
      )
    },
  })
}

function errorMessage(e: unknown): string {
  if (e instanceof McpImportError) return `import[${e.connectorId}] ${e.code}: ${e.message}`
  if (e instanceof UnknownConnectorError) return e.message
  return (e as Error).message
}

function dispatch(input: string, deps: McpRegDeps): string | Promise<string> {
  const parts = input.split(/\s+/).filter(Boolean)
  const sub = parts[0] ?? 'help'
  const rest = parts.slice(1)
  const { store, bridge } = deps
  switch (sub) {
    case 'help':
      return HELP

    case 'list': {
      if (store.isDamaged()) return damageNotice(store)
      const connectors = store.list()
      if (connectors.length === 0) return 'registry is empty — import with: mcp-reg import <path|json>'
      return connectors
        .map((c) => {
          const view = publicView(c)
          const probe = bridge.probeCache.get(c.id)
          const probeText = probe ? (probe.ok ? `alive (${probe.latencyMs}ms)` : `down (${probe.code})`) : 'unprobed'
          const grants = view.grantedTools.length ? view.grantedTools.join(',') : 'none'
          return `${c.enabled ? 'on ' : 'off'} ${c.id}  [${c.transport}] ${view.target}  mode=${c.permissionMode}  grants=${grants}${c.pendingConfirmation ? '  UNCONFIRMED' : ''}  probe=${probeText}`
        })
        .join('\n')
    }

    case 'probe': {
      const id = rest[0] ?? ''
      if (!id) return 'usage: mcp-reg probe <id>'
      return bridge.probe(id).then((outcome) => {
        if (outcome.ok) {
          return `alive in ${outcome.latencyMs}ms — ${outcome.serverName ?? 'unknown server'} ${outcome.serverVersion ?? ''} (protocol ${outcome.protocolVersion ?? '?'})`
        }
        return `probe failed: ${outcome.code} — ${outcome.message}`
      })
    }

    case 'add': {
      const source = rest.join(' ')
      if (!source) return 'usage: mcp-reg add <json> — one connector object, "id" required'
      let parsed: unknown
      try { parsed = JSON.parse(source) } catch { return 'mcp-reg add: input is not valid JSON' }
      const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null
      if (!obj) return 'mcp-reg add: input must be a JSON object'
      const { id, ...fields } = obj
      if (!id || typeof id !== 'string') return 'mcp-reg add: "id" is required (string)'
      try {
        const record = store.add({ id, connector: fields })
        return `created "${record.id}" [${record.transport}] — disabled + unconfirmed. Probe, review, then: mcp-reg confirm ${record.id}`
      } catch (e) {
        return errorMessage(e)
      }
    }

    case 'remove': {
      const id = rest[0] ?? ''
      if (!id) return 'usage: mcp-reg remove <id>'
      try {
        store.remove(id)
        bridge.forget(id)
        return `removed "${id}" (bridge session dropped)`
      } catch (e) {
        return errorMessage(e)
      }
    }

    case 'import': {
      const source = rest.join(' ')
      if (!source) return 'usage: mcp-reg import <path|inline json>'
      const text = readImportSource(source)
      const { records } = importMcpJson(text, { now: Date.now() })
      for (const record of records) store.upsert(record)
      return `imported ${records.length} connector(s), all disabled + unconfirmed. Review, probe, then: mcp-reg confirm <id>\n`
        + records.map((r) => `  - ${r.id} [${r.transport}] ${redactTarget(r)}`).join('\n')
    }

    case 'export': {
      const includeSecrets = rest.includes('--secrets')
      return exportMcpJson(store.list(), { includeSecrets })
    }

    case 'confirm':
      return withRecord(store, rest[0], (record) => {
        store.confirm(record.id)
        return `confirmed "${record.id}" — enabled`
      })

    case 'enable':
    case 'disable':
      return withRecord(store, rest[0], (record) => {
        store.setEnabled(record.id, sub === 'enable')
        return `${sub}d "${record.id}"`
      })

    case 'mode': {
      const id = rest[0] ?? ''
      const mode = rest[1] ?? ''
      if (!id || (mode !== 'review-all' && mode !== 'allowlist')) {
        return 'usage: mcp-reg mode <id> <review-all|allowlist>'
      }
      return withRecord(store, id, (c) => {
        store.updatePolicy(c.id, { permissionMode: mode })
        return `mode of "${c.id}" set to ${mode}`
      })
    }

    case 'grant':
    case 'revoke': {
      const id = rest[0] ?? ''
      const tool = rest[1] ?? ''
      if (!id || !tool) return `usage: mcp-reg ${sub} <id> <tool|*>`
      return withRecord(store, id, (c) => {
        const record = store.get(c.id)
        if (!record) return `no connector "${c.id}"`
        const next: Record<string, 'allow' | 'review'> = { ...record.toolPermissions }
        if (sub === 'grant') {
          next[tool] = 'allow'
        } else {
          for (const key of Object.keys(next)) {
            if (tool === '*' || key === tool) delete next[key]
          }
        }
        store.updatePolicy(c.id, { toolPermissions: next })
        if (sub === 'grant') return `granted "${tool}" on "${c.id}" — agent calls to it are now policy-approved`
        return `revoked on "${c.id}"${tool === '*' ? ' (all grants cleared)' : ` ("${tool}" back to review)`}`
      })
    }

    case 'trust': {
      const id = rest[0] ?? ''
      const flag = rest[1] ?? ''
      if (!id || (flag !== 'on' && flag !== 'off')) return 'usage: mcp-reg trust <id> <on|off>'
      return withRecord(store, id, (c) => {
        store.updatePolicy(c.id, { trustReadOnlyHint: flag === 'on' })
        return `trustReadOnlyHint of "${c.id}" = ${flag}`
      })
    }

    case 'call': {
      const id = rest[0] ?? ''
      const tool = rest[1] ?? ''
      if (!id || !tool) return 'usage: mcp-reg call <id> <tool> [json-arguments]'
      let args: Record<string, unknown> = {}
      const jsonPart = rest.slice(2).join(' ')
      if (jsonPart) {
        try {
          args = JSON.parse(jsonPart) as Record<string, unknown>
        } catch (e) {
          return `arguments are not valid JSON: ${(e as Error).message}`
        }
      }
      return bridge
        .callTool(id, tool, args, 'user', deps.getDefaultMode())
        .then((outcome) => JSON.stringify(outcome, null, 2))
    }

    default:
      return `unknown subcommand "${sub}"\n\n${HELP}`
  }
}

function withRecord(store: RegistryStore, id: string | undefined, fn: (record: ConnectorRecord) => string): string {
  if (!id) return 'missing <id>'
  try {
    const record = store.get(id)
    if (!record) return `no connector "${id}" in the registry`
    return fn(record)
  } catch (e) {
    if (e instanceof UnknownConnectorError) return `no connector "${id}" in the registry`
    throw e
  }
}

function damageNotice(store: RegistryStore): string {
  return `REGISTRY DAMAGED — fail-closed: every connector is treated as nonexistent.\nreason: ${store.damageReason}\ncorrupt file preserved at: ${store.corruptFilePath}\nFix or remove it, then restart. The registry refuses writes until then.`
}

function readImportSource(source: string): string {
  // Inline JSON starts with { — anything else is treated as a file path.
  if (source.trimStart().startsWith('{')) return source
  return readFileSync(source, 'utf8')
}
