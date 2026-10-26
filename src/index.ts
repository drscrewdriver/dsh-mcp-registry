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
import { NativeToolLazyLoader, buildDiscoveryGuide, scopeKeyOf, type LazyOptions, type NativeIndexEntry } from './lazy.ts'
import { createStatusTool, createBridgeTool, createListToolsTool, createDiscoverTool, createActivateTool } from './surface/tool.ts'
import { registerMcpRegCommand } from './surface/command.ts'
import { registerMcpRegistryGateway } from './surface/http.ts'
import type { AssembleContextLike, AssemblyToolSchema, McpRegistryContext, PromptAssemblyLike, RawConfig } from './types.ts'

export const name = 'dsh-mcp-registry'
// Tools AND commands: the dsh 0.2.0 host's cordis layer THROWS on access to a
// service property that is not declared in inject ("cannot get property
// 'commands' without inject"), so the old `typeof ctx.commands?.register`
// guard crashes before it can degrade anything. Declare the service, keep the
// method-level feature detect. webServer stays OUT on purpose: ctx.get() is
// the optional-service accessor and needs no inject (dsh-browser-cdp pattern).
// systemPrompt is declared so the lazy loader's `system-prompt/assemble`
// listener attaches before any agent assembly runs (ordering, not access).
export const inject = ['tools', 'commands', 'systemPrompt']
export const Config = ConfigSchema

/** Resolved (post-defaults) runtime config — live getters over volatile refs. */
export interface ResolvedRegistryConfig {
  enabled: boolean
  defaultPermissionMode: PermissionMode
  probeTimeoutMs: number
  lazyNativeTools: boolean
  lazyEagerIndex: boolean
  lazyKeepAlways: string[]
  lazyDescriptionLimit: number
}

export function resolveConfig(config: RawConfig): ResolvedRegistryConfig {
  return {
    // Kill switches default ON but the registry itself still boots fail-closed
    // on a damaged file; this switch is the user's master off, not a safety net.
    enabled: config.enabled !== false,
    defaultPermissionMode: normalizePermissionMode(config.defaultPermissionMode),
    probeTimeoutMs: clampNumber(config.probeTimeoutMs, 200, 30_000, 3_000),
    // Lazy loading is opt-in: absent or false leaves every tool eagerly declared.
    lazyNativeTools: config.lazyNativeTools === true,
    // Eager index defaults ON (Mode B); only an explicit false selects tool_discover-first (Mode A).
    lazyEagerIndex: config.lazyEagerIndex !== false,
    lazyKeepAlways: normalizeKeepAlways(config.lazyKeepAlways),
    lazyDescriptionLimit: clampNumber(config.lazyDescriptionLimit, 20, 2000, 160),
  }
}

/** Coerce the keep-always list to a deduped array of non-empty strings. */
function normalizeKeepAlways(value: unknown): string[] {
  if (!Array.isArray(value)) return ['bash', 'read', 'write', 'edit', 'glob', 'grep']
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item) seen.add(item)
  }
  return [...seen]
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
    get lazyNativeTools() { return resolveConfig(config).lazyNativeTools },
    get lazyEagerIndex() { return resolveConfig(config).lazyEagerIndex },
    get lazyKeepAlways() { return resolveConfig(config).lazyKeepAlways },
    get lazyDescriptionLimit() { return resolveConfig(config).lazyDescriptionLimit },
  }

  const bridge = new McpBridge(store, { getProbeTimeoutMs: () => cfg.probeTimeoutMs })
  ctx.effect?.(() => bridge.closeAll())

  // Native tool lazy loading. isEnabled ANDs the registry master switch so
  // `enabled: false` folds nothing back in — the whole plugin is off.
  const lazyOpts: LazyOptions = {
    isEnabled: () => cfg.enabled && cfg.lazyNativeTools,
    keepAlways: () => cfg.lazyKeepAlways,
    descriptionLimit: () => cfg.lazyDescriptionLimit,
    eagerIndex: () => cfg.lazyEagerIndex,
  }
  const lazy = new NativeToolLazyLoader(lazyOpts)

  const registerTool = (tool: unknown): void => {
    const dispose = ctx.tools.register(tool) as unknown as () => void
    ctx.effect?.(() => dispose)
  }
  registerTool(createStatusTool(store, bridge))
  registerTool(createListToolsTool(bridge))
  registerTool(createBridgeTool(bridge, () => cfg.defaultPermissionMode))
  // Two always-on meta-tools; they answer honestly when lazy loading is off.
  registerTool(createDiscoverTool(lazy, lazyOpts))
  registerTool(createActivateTool(lazy, lazyOpts))

  // Fold candidate native tools out of the authoritative assembly. The listener
  // runs AFTER `next()` so it sees the full post-waterfall tool set (registry,
  // MCP, and any scoped contribution all merged) and returns the reduced one.
  // fail-open: disabled or a non-array tools payload returns the assembly
  // untouched, so the worst case is today's eager behaviour.
  if (typeof ctx.on === 'function') {
    const assembleDispose = ctx.on('system-prompt/assemble', (assembly: unknown, context: unknown, next: unknown) => {
      const run = next as () => Promise<PromptAssemblyLike>
      return run().then((assembled) => lazy.project(assembled, (context ?? {}) as AssembleContextLike))
    }) as unknown as () => void
    if (typeof assembleDispose === 'function') ctx.effect?.(() => assembleDispose)
  }

  // Discovery guide — because the registry never declares per-MCP-tool schemas
  // (the bridge owns them), the model needs prompt prose telling it WHICH MCP
  // connectors exist right now (id + display name only, never url/credential)
  // and how to enter each. The connector list is recomputed every assembly so a
  // newly added/removed connector shows without a restart; the lazy paragraph is
  // appended only when folding is active. An empty result (registry off)
  // contributes nothing to the prompt.
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    let guideOrder = 3100 // SECTION_ORDERS.MCP_SERVERS fallback
    try { guideOrder = ctx.systemPrompt.getSectionOrder?.('MCP_SERVERS') ?? 3100 } catch { /* keep fallback */ }
    const sectionDispose = ctx.systemPrompt.section({
      name: 'dsh-mcp-registry:discovery-guide',
      order: guideOrder,
      text: (context) => {
        const ctxLike = (context ?? {}) as AssembleContextLike
        let connectors: Array<{ id: string; name?: string }> = []
        try {
          connectors = store
            .list()
            .filter((c) => c.enabled && !c.pendingConfirmation)
            .map((c) => ({ id: c.id, name: c.name }))
        } catch { /* damaged store: omit the list, keep the mechanism prose */ }
        // Eager native index (Mode B): list the hidden native tools from the
        // agent's live visible set so it is correct on the first assembly. Fall
        // back to the fold catalog when the host exposes no ctx.tools.schemas.
        let nativeIndex: NativeIndexEntry[] = []
        const lazyEnabled = lazyOpts.isEnabled()
        if (lazyEnabled && lazyOpts.eagerIndex()) {
          const scope = scopeKeyOf(ctxLike.agent ?? ctxLike.scope)
          // No initializer: both arms below assign, and a pre-seeded `[]` is
          // dead on the success path (eslint no-useless-assignment).
          let visible: AssemblyToolSchema[]
          try { visible = ctx.tools.schemas?.(ctxLike.agent) ?? [] } catch { visible = [] }
          nativeIndex = visible.length > 0
            ? lazy.nativeIndex(scope, visible)
            : lazy.discover(scope).map((r) => ({ name: r.name, summary: r.description }))
        }
        return buildDiscoveryGuide({ registryEnabled: cfg.enabled, lazyEnabled, connectors, nativeIndex })
      },
    }) as unknown as () => void
    if (typeof sectionDispose === 'function') ctx.effect?.(() => sectionDispose)
  }

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
          .filter((c) => c.enabled && !c.pendingConfirmation && (c.permissionMode === 'allowlist' || c.permissionMode === 'allow-all'))
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
