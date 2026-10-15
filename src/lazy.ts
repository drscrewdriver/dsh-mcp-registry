/**
 * Native tool lazy loading.
 *
 * Folds model-facing NATIVE tool schemas out of the standing prompt and reveals
 * them on demand, so a third-party LM connector (which cannot carry the
 * `mid-conversation-tool-changes` blocks the official DeepSeek route uses for
 * `deferLoading`) still pays a near-constant tool cost instead of O(tool count)
 * on every request.
 *
 * The mechanism lives entirely at the `system-prompt/assemble` waterfall:
 *  - tools stay registered in `ctx.tools` (execution, TUI, and restrict masks
 *    are untouched) — only the PROMPT payload changes;
 *  - a lazy candidate is any assembled tool that is not (a) a registry-owned
 *    tool, (b) an `mcp__*` tool (the bridge owns that surface), (c) in the
 *    keep-always core set, or (d) already activated for the current scope;
 *  - folding one candidate strips it from `assembly.tools` and records its full
 *    schema in a side catalog so `tool_activate` can hand it back verbatim.
 *
 * Activation is scoped per agent (`context.scope` / `exec.agent` share the same
 * `agent.id`), matching how `dsh-mcp-lazy` isolates per session: one agent
 * activating a tool never reveals it to another, and nothing persists across a
 * host restart (a fresh process re-folds to the cold set).
 *
 * fail-open: when disabled the interceptor is a pure pass-through and the two
 * meta-tools report that lazy loading is off — the worst case is the current
 * eager behaviour, never a crippled agent.
 *
 * @module dsh-mcp-registry/lazy
 */
import type {
  AssembleContextLike,
  AssemblyToolSchema,
  PromptAssemblyLike,
} from './types.ts'

/** The two always-on discovery meta-tools this module contributes. */
export const TOOL_DISCOVER = 'tool_discover'
export const TOOL_ACTIVATE = 'tool_activate'

/**
 * Names this plugin registers itself and must never fold (folding them would
 * hide the very tools used to reveal the rest).
 */
const OWN_TOOL_NAMES = new Set<string>([
  TOOL_DISCOVER,
  TOOL_ACTIVATE,
  'mcp_registry_status',
  'mcp_bridge_list_tools',
  'mcp_bridge_call',
])

/** The MCP namespace prefix — those tools are governed by the bridge, not here. */
const MCP_PREFIX = 'mcp__'

/** Live view of the lazy config, resolved per call so volatile edits apply hot. */
export interface LazyOptions {
  /** Master switch (AND of the registry `enabled` gate and `lazyNativeTools`). */
  isEnabled(): boolean
  /** Native tool names that stay eagerly declared. */
  keepAlways(): readonly string[]
  /** Max description characters shown per tool in the discover catalog. */
  descriptionLimit(): number
  /** When enabled, the guide injects a resident native-tool index (Mode B) vs tool_discover-only (Mode A). */
  eagerIndex(): boolean
}

/** Derive a stable string scope key from an assemble context or exec agent. */
export function scopeKeyOf(source: unknown): string {
  if (source && typeof source === 'object') {
    const id = (source as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
    if (typeof id === 'number') return String(id)
  }
  if (typeof source === 'string' && source) return source
  // Unscoped assembly (no agent): one shared global bucket.
  return '\u0000global'
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, Math.max(0, limit - 1))}\u2026`
}

/**
 * The discovery guide rendered into the system prompt so the model knows the
 * MCP bridge and native-tool lazy loading exist and how to enter each.
 *
 * MCP connectors are never declared as individual tools (the bridge owns them),
 * so the guide names WHICH connectors are available right now — the model sees
 * the list without paying a `mcp_registry_status` round-trip — and defers only
 * the per-connector tool schemas to `mcp_bridge_list_tools`. The lazy paragraph
 * is appended only when native folding is active. Empty when the registry is
 * disabled. Ids are the callable key; only id + display name are surfaced (no
 * url / command / credential), matching the redacted tool views.
 * @param input.registryEnabled - the registry master switch.
 * @param input.lazyEnabled - lazy native-tool loading (already ANDed with the switch).
 * @param input.connectors - enabled, confirmed connectors to name in the prompt.
 */
export interface GuideConnector {
  id: string
  name?: string
}

/** One eager native-tool index row (name + truncated one-line summary). */
export interface NativeIndexEntry {
  name: string
  summary: string
}

export interface GuideInput {
  registryEnabled: boolean
  lazyEnabled: boolean
  connectors: readonly GuideConnector[]
  /** Hidden native tools to name in the prompt (Mode B). Empty ⇒ tool_discover-first (Mode A). */
  nativeIndex: readonly NativeIndexEntry[]
}

export function buildDiscoveryGuide(input: GuideInput): string {
  if (!input.registryEnabled) return ''
  const parts: string[] = []
  if (input.connectors.length > 0) {
    const listing = input.connectors
      .map((c) => (c.name ? `\`${c.id}\` (${c.name})` : `\`${c.id}\``))
      .join(', ')
    parts.push(
      `MCP connectors available now: ${listing}. Their tools are not declared individually — ` +
      'call `mcp_bridge_list_tools` with a connector id to see its tools, then `mcp_bridge_call` '
      + 'with {connector, tool, arguments} to run one. A `needs_review` answer means a human must grant or run it.',
    )
  } else {
    parts.push(
      'No MCP connectors are registered and enabled yet (a human adds them via the `/mcp-reg` command). '
      + 'When present, they are reached through `mcp_registry_status` → `mcp_bridge_list_tools` → `mcp_bridge_call`, '
      + 'never as individually declared tools.',
    )
  }
  if (input.lazyEnabled) {
    if (input.nativeIndex.length > 0) {
      const idx = input.nativeIndex.map((t) => `\`${t.name}\` (${t.summary})`).join(', ')
      parts.push(
        `Native tool lazy loading is ON. Hidden native tools you can activate: ${idx}. `
        + 'Call `tool_activate` with a name to declare one in full starting your next step '
        + '(`tool_discover` lists the same with active flags). Core tools and MCP tools are unaffected.',
      )
    } else {
      parts.push(
        'Native tool lazy loading is ON: most non-core tool schemas are hidden from this list. '
        + 'Call `tool_discover` to see hidden native tools, then `tool_activate` with a name to declare one '
        + 'in full starting your next step. Core tools and MCP tools are unaffected.',
      )
    }
  }
  return parts.join('\n')
}

export class NativeToolLazyLoader {
  private readonly opts: LazyOptions
  /** Full schemas seen while folding, keyed by tool name — restore source for activation. */
  private readonly catalog = new Map<string, AssemblyToolSchema>()
  /** Per-scope activated tool names (in-memory only, never persisted). */
  private readonly activated = new Map<string, Set<string>>()

  constructor(opts: LazyOptions) {
    this.opts = opts
  }

  /** A tool name is foldable only if it is native, non-own, and not kept. */
  private isLazyCandidate(name: string, keep: ReadonlySet<string>): boolean {
    if (OWN_TOOL_NAMES.has(name)) return false
    if (name.startsWith(MCP_PREFIX)) return false
    if (keep.has(name)) return false
    return true
  }

  /**
   * Rewrite one authoritative assembly for its scope: strip folded tools, keep
   * the meta-tools + core + already-active set. Returns the same object when
   * nothing changed (disabled, or nothing foldable).
   */
  project(assembly: PromptAssemblyLike, context: AssembleContextLike): PromptAssemblyLike {
    if (!this.opts.isEnabled()) return assembly
    if (!Array.isArray(assembly.tools)) return assembly

    const scope = scopeKeyOf(context.agent ?? context.scope)
    const active = this.activated.get(scope)
    const keep = new Set(this.opts.keepAlways())
    const out: AssemblyToolSchema[] = []
    let folded = 0
    for (const tool of assembly.tools) {
      if (tool && typeof tool.name === 'string' && this.isLazyCandidate(tool.name, keep) && !active?.has(tool.name)) {
        // Cache the full schema so tool_activate can return it verbatim later.
        this.catalog.set(tool.name, tool)
        folded += 1
        continue
      }
      out.push(tool)
    }
    if (folded === 0) return assembly
    return { ...assembly, tools: out }
  }

  /** Compact catalog of currently-hidden tools for a scope, for tool_discover. */
  discover(scope: string): Array<{ name: string; description: string; active: boolean }> {
    const active = this.activated.get(scope)
    const keep = new Set(this.opts.keepAlways())
    const limit = this.opts.descriptionLimit()
    const rows: Array<{ name: string; description: string; active: boolean }> = []
    for (const [name, schema] of this.catalog) {
      if (!this.isLazyCandidate(name, keep)) continue
      rows.push({
        name,
        description: truncate(schema.description ?? '', limit),
        active: active?.has(name) === true,
      })
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return rows
  }

  /**
   * Compact name+summary index of the native tools currently hidden for a scope,
   * computed from the agent's LIVE visible tool set (so it is correct on the very
   * first assembly — no fold warm-up gap). A tool is a hidden candidate when it
   * is foldable (native, non-own, non-mcp, not kept) AND not yet activated here.
   * @param scope - the agent scope key.
   * @param visible - the agent's current visible schemas (from ctx.tools.schemas).
   */
  nativeIndex(scope: string, visible: readonly AssemblyToolSchema[]): NativeIndexEntry[] {
    const active = this.activated.get(scope)
    const keep = new Set(this.opts.keepAlways())
    const limit = this.opts.descriptionLimit()
    const rows: NativeIndexEntry[] = []
    for (const tool of visible) {
      if (!tool || typeof tool.name !== 'string') continue
      if (this.isLazyCandidate(tool.name, keep) && !active?.has(tool.name)) {
        rows.push({ name: tool.name, summary: truncate(tool.description ?? '', limit) })
      }
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return rows
  }

  /**
   * Activate one tool for a scope. Returns the restored full schema when the
   * tool was a known foldable candidate; `unknown` when it is not in the
   * catalog (never folded here — an mcp/core/own/typo name); `already` when it
   * was active before this call.
   */
  activate(scope: string, name: string): { status: 'activated' | 'already' | 'unknown'; schema?: AssemblyToolSchema } {
    const keep = new Set(this.opts.keepAlways())
    const schema = this.catalog.get(name)
    if (schema === undefined || !this.isLazyCandidate(name, keep)) {
      return { status: 'unknown' }
    }
    let set = this.activated.get(scope)
    if (!set) {
      set = new Set()
      this.activated.set(scope, set)
    }
    if (set.has(name)) return { status: 'already', schema }
    set.add(name)
    return { status: 'activated', schema }
  }

  /** True when the tool is currently declared for the scope (kept or activated). */
  isActive(scope: string, name: string): boolean {
    if (this.opts.keepAlways().includes(name)) return true
    return this.activated.get(scope)?.has(name) === true
  }

  /** Drop every held catalog/activation entry for one scope (agent teardown). */
  forget(scope: string): void {
    this.activated.delete(scope)
  }

  /** Test/support introspection: number of schemas currently cached. */
  catalogSize(): number {
    return this.catalog.size
  }
}
