/**
 * Agent-facing tools. Exactly three, all with minimal model-visible surface:
 *  - mcp_registry_status: read-only diagnostics, redacted projection.
 *  - mcp_bridge_list_tools: read-only discovery, refreshes the evidence table.
 *  - mcp_bridge_call: the ONLY execution path for agents, routed through the
 *    authz seam; review verdicts return needs_review honestly.
 *
 * No prompt sections, no agent-writable registry tools — writes belong to the
 * human via /mcp-reg or the settings page.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { publicView, type ConnectorRecord } from '../core/model.ts'
import type { RegistryStore } from '../core/store.ts'
import type { McpBridge } from '../bridge.ts'
import type { PermissionMode } from '../core/model.ts'

/**
 * defineTool's option type recurses through schemastery's `InferObject` and
 * trips TS2321 (excessive stack depth). The option shapes are proven by
 * dsh-browser-cdp, which casts through `any` at the call sites for the same
 * reason.
 */
type DefineToolOpts = any

const LOOSE_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean', required: true } },
} as const

function renderAsJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function createStatusTool(store: RegistryStore, bridge: McpBridge): DefineToolOpts {
  return defineTool({
    name: 'mcp_registry_status',
    description:
      'List the registered MCP connectors with their authorization policy and last probe result. '
      + 'Read-only diagnostics: targets are redacted (origin / command basename) and no credentials are included. '
      + 'Use it to check which connectors exist before calling mcp_bridge_call.',
    parameters: {},
    output: { schema: LOOSE_OBJECT_SCHEMA, render: renderAsJson },
    execute: async () => {
      if (store.isDamaged()) {
        return {
          ok: false,
          damaged: true,
          reason: store.damageReason,
          corruptFile: store.corruptFilePath,
          note: 'The registry file failed to load; every connector is treated as nonexistent until a human fixes it.',
        }
      }
      const connectors = store.list().map((record) => {
        const probe = bridge.probeCache.get(record.id)
        return {
          ...publicView(record),
          probe: probe
            ? {
                ok: probe.ok,
                at: probe.at,
                latencyMs: probe.latencyMs,
                ...(probe.ok
                  ? { serverName: probe.serverName, protocolVersion: probe.protocolVersion }
                  : { code: probe.code, message: probe.message }),
              }
            : { ok: null, note: 'never probed in this session' },
        }
      })
      return { ok: true, connectors }
    },
  } as DefineToolOpts)
}

export function createListToolsTool(bridge: McpBridge): DefineToolOpts {
  return defineTool({
    name: 'mcp_bridge_list_tools',
    description: 'List the tools a registered MCP connector currently exposes (runs tools/list against it). Read-only.',
    parameters: {
      connector: { type: 'string', description: 'Connector id from mcp_registry_status.', required: true },
    },
    output: { schema: LOOSE_OBJECT_SCHEMA, render: renderAsJson },
    execute: async (args: { connector: string }) => {
      const tools = await bridge.listTools(args.connector)
      return {
        ok: true,
        connector: args.connector,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          annotations: t.annotations ?? {},
        })),
      }
    },
  } as DefineToolOpts)
}

export function createBridgeTool(bridge: McpBridge, getDefaultMode: () => PermissionMode): DefineToolOpts {
  return defineTool({
    name: 'mcp_bridge_call',
    description:
      'Call a tool on a registered MCP connector. The connector policy decides silently-allowed vs needs_review: '
      + 'a needs_review answer means the human must grant the tool (mcp-reg grant) or call it themselves (mcp-reg call). '
      + 'Use mcp_registry_status to discover connector ids and mcp_bridge_list_tools to discover tool names.',
    parameters: {
      connector: { type: 'string', description: 'Connector id from mcp_registry_status.', required: true },
      tool: { type: 'string', description: 'Tool name as exposed by that connector.', required: true },
      arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments object (validated by the remote server).' },
    },
    output: { schema: LOOSE_OBJECT_SCHEMA, render: renderAsJson },
    timeoutMs: 70_000,
    execute: async (args: { connector: string; tool: string; arguments?: Record<string, unknown> }) => {
      const outcome = await bridge.callTool(args.connector, args.tool, args.arguments ?? {}, 'agent', getDefaultMode())
      if (outcome.status === 'needs_review') {
        return { ok: false, status: outcome.status, reason: outcome.reason, hint: outcome.hint }
      }
      return { ok: outcome.ok, status: outcome.status, result: outcome.result }
    },
  } as DefineToolOpts)
}

/** Test-support invariant: a public view must never carry a credential. */
export function assertNoCredentialLeak(record: ConnectorRecord, view: unknown): void {
  const text = JSON.stringify(view)
  const leaks: string[] = []
  if (record.authToken && text.includes(record.authToken)) leaks.push('authToken')
  if (record.transport === 'streamable-http' && record.url && text.includes(record.url)) leaks.push('url')
  for (const [k, v] of Object.entries(record.env)) {
    if (v && text.includes(v)) leaks.push(`env.${k}`)
  }
  if (leaks.length > 0) {
    throw new Error(`credential leak in public view: ${leaks.join(', ')}`)
  }
}
