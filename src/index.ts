/**
 * dsh-mcp-registry — plugin entry.
 *
 * A governed registry for MCP connectors with a fail-closed, multi-level
 * authorization seam. Responsibility split (same line dsh-mcp-connector draws):
 * this plugin owns the directory, the policy, the probe and the console; the
 * session/transport work per call is owned by the thin clients in src/client.
 *
 * Surfaces, in decreasing privilege:
 *  - /mcp-reg command  — human operator console; the ONLY writer path.
 *  - ctx.provide('dsh-mcp-registry') — in-process consumers (future).
 *  - webServer /mcp-registry/api/status — opportunistic, redacted, GET only.
 *  - mcp_registry_status / mcp_bridge_list_tools / mcp_bridge_call — the ONLY
 *    model-visible tools; the bridge refuses honestly on a review verdict.
 *
 * Headless/TUI hosts (no webServer) and hosts without the commands service
 * degrade to tools-only, guarded at every optional seam.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { Config as ConfigSchema } from './config.ts'
import { RegistryStore, type StoreFileIo } from './core/store.ts'
import { normalizePermissionMode, publicView, type PermissionMode } from './core/model.ts'
import { McpBridge } from './bridge.ts'
import { createStatusTool, createBridgeTool, createListToolsTool } from './surface/tool.ts'
import { registerMcpRegCommand } from './surface/command.ts'
import { registerMcpRegistryGateway } from './surface/http.ts'
import type { McpRegistryContext, RawConfig } from './types.ts'

export const name = 'dsh-mcp-registry'
// Tools AND commands: the dsh 0.2.0 host's cordis layer THROWS on access to a
// service property that is not declared in inject ("cannot get property
// 'commands' without inject"), so the old `typeof ctx.commands?.register`
// guard crashes before it can degrade anything. Declare the service, keep the
// method-level feature detect. webServer stays OUT on purpose: ctx.get() is
// the optional-service accessor and needs no inject (dsh-browser-cdp pattern).
export const inject = ['tools', 'commands']
export const Config = ConfigSchema

/** Resolved (post-defaults) runtime config — live getters over volatile refs. */
export interface ResolvedRegistryConfig {
  enabled: boolean
  defaultPermissionMode: PermissionMode
  probeTimeoutMs: number
}

export function resolveConfig(config: RawConfig): ResolvedRegistryConfig {
  return {
    // Kill switches default ON but the registry itself still boots fail-closed
    // on a damaged file; this switch is the user's master off, not a safety net.
    enabled: config.enabled !== false,
    defaultPermissionMode: normalizePermissionMode(config.defaultPermissionMode),
    probeTimeoutMs: clampNumber(config.probeTimeoutMs, 200, 30_000, 3_000),
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function apply(ctx: McpRegistryContext, config: RawConfig = {}): void {
  const rootDir = join(homedir(), '.dsh', 'mcp-registry')
  const store = new RegistryStore(realStoreIo(), { dir: rootDir })
  store.load()

  const cfg = {
    get enabled() { return resolveConfig(config).enabled },
    get defaultPermissionMode() { return resolveConfig(config).defaultPermissionMode },
    get probeTimeoutMs() { return resolveConfig(config).probeTimeoutMs },
  }

  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => cfg.probeTimeoutMs })
  ctx.effect?.(() => bridge.closeAll())

  const registerTool = (tool: unknown): void => {
    const dispose = ctx.tools.register(tool) as unknown as () => void
    ctx.effect?.(() => dispose)
  }
  registerTool(createStatusTool(store, bridge))
  registerTool(createListToolsTool(bridge))
  registerTool(createBridgeTool(bridge, () => cfg.defaultPermissionMode))

  const commandDispose = registerMcpRegCommand(ctx, {
    store,
    bridge,
    getDefaultMode: () => cfg.defaultPermissionMode,
  })
  if (commandDispose !== undefined) ctx.effect?.(() => commandDispose)

  // In-process consumers: a thin, redacted surface. listAuthorized returns
  // only allowlist-mode connectors — review-all connectors are not callable
  // without the human path, so naming them here would promise too much.
  if (typeof ctx.provide === 'function') {
    const surface = {
      status(): unknown {
        if (store.isDamaged()) return { damaged: true, reason: store.damageReason }
        return {
          enabled: cfg.enabled,
          connectors: store.list().map((c) => publicView(c)),
        }
      },
      listAuthorized(consumerId: string): Array<ReturnType<typeof publicView>> {
        void consumerId // v1: per-consumer grants are per-tool grants; kept for surface stability
        if (!cfg.enabled || store.isDamaged()) return []
        return store
          .list()
          .filter((c) => c.enabled && !c.pendingConfirmation && c.permissionMode === 'allowlist')
          .map((c) => publicView(c))
      },
    }
    const disposeProvide = ctx.provide('dsh-mcp-registry', surface) as unknown as () => void
    if (typeof disposeProvide === 'function') ctx.effect?.(() => disposeProvide)
  }

  // Web shell only: the settings-card gateway (POST-only, same-origin). The
  // routes are the /mcp-reg subcommands over HTTP so the client card can
  // manage connectors; responses carry redacted projections only.
  //
  // The webServer service arrives LATE on the 0.2.0 host (provided by the
  // dsh-host-webserver plugin, which starts after us): both an apply-time and
  // an effect-time ctx.get('webServer') returned undefined there (probed).
  // The cordis dynamic inject fires exactly when the service starts — the
  // same pattern dsh-thinking-levels uses for modelDirectories. On hosts
  // without a web server the inject simply never fires; the fallback covers
  // older hosts where the service is ready at apply time.
  const dynamicInject = (ctx as { inject?: (deps: readonly string[], cb: (sctx: McpRegistryContext) => void) => void }).inject
  const gatewayDeps = {
    store,
    bridge,
    getEnabled: () => cfg.enabled,
  }
  if (typeof dynamicInject === 'function') {
    dynamicInject.call(ctx, ['webServer'], (sctx: McpRegistryContext) => {
      const gatewayDispose = registerMcpRegistryGateway(sctx, gatewayDeps)
      if (typeof gatewayDispose === 'function') ctx.effect?.(() => gatewayDispose)
    })
  } else {
    const gatewayDispose = registerMcpRegistryGateway(ctx, gatewayDeps)
    if (typeof gatewayDispose === 'function') ctx.effect?.(() => gatewayDispose)
  }
}

/**
 * Real filesystem IO, isolated here so everything else (and every test) runs
 * against the injected StoreFileIo interface instead of node:fs.
 */
function realStoreIo(): StoreFileIo {
  return {
    readFile: (path) => {
      try {
        return fs.readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, data) => fs.writeFileSync(path, data, 'utf8'),
    rename: (src, dst) => fs.renameSync(src, dst),
    rmIfExists: (path) => {
      try {
        fs.rmSync(path, { force: true })
      } catch { /* nothing to remove */ }
    },
    mkdirp: (path) => fs.mkdirSync(path, { recursive: true }),
    listDir: (path) => {
      try {
        return fs.readdirSync(path)
      } catch {
        return []
      }
    },
    rm: (path) => fs.rmSync(path, { force: true }),
    exists: (path) => fs.existsSync(path),
  }
}
