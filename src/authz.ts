/**
 * The single authorization seam.
 *
 * EVERY path that results in an MCP tool execution must route its decision
 * through `resolveToolAccess` — the /mcp-reg command, the agent bridge tool,
 * and the provide()d service surface. Restating the rules anywhere else is how
 * the two paths drift apart until the UI says "unauthorized" while the agent
 * executes (the drift openhanako prevents with the same shared-seam pattern).
 *
 * The rules, in precedence order (mirrors openhanako resolveMcpToolPermissionKind):
 *   1. A server-declared destructive tool is NEVER silently approved, even
 *      when the user explicitly allowed it. Known danger outranks authorization.
 *   2. An explicit user grant needs no evidence from the server: an empty
 *      annotation side table must not weaken it.
 *   3. Implicit trust (trustReadOnlyHint) needs FRESH evidence: only when this
 *      process has actually seen the running server declare readOnlyHint for
 *      this tool. With no live listing it fails closed to review, because the
 *      alternative is trusting a claim nobody made in this run.
 *
 * Unknown/malformed inputs fall to the strictest interpretation by
 * construction: normalizeToolPermission returns undefined for anything but
 * allow/review, and the fallbacks below all land on 'review'.
 */

export type AccessKind = 'allow' | 'review'

export interface AccessPolicy {
  /** Connector-level mode; anything but 'allowlist' reviews everything. */
  permissionMode: unknown
  /** Per-tool explicit grant; unknown values are treated as absent. */
  toolPermission: unknown
  /** User opt-in to trusting the server's own read-only claim. */
  trustReadOnlyHint: boolean
}

export interface ToolAnnotations {
  readOnlyHint?: unknown
  destructiveHint?: unknown
}

/** Evidence as last reported by the RUNNING server — never persisted. */
export interface LiveEvidence {
  /** True only when this process listed tools and saw this tool alive. */
  listed: boolean
  annotations?: ToolAnnotations
}

export const NO_EVIDENCE: LiveEvidence = { listed: false }

export function resolveToolAccess(policy: AccessPolicy, evidence: LiveEvidence = NO_EVIDENCE): AccessKind {
  if (policy.permissionMode !== 'allowlist') return 'review'

  const annotations = evidence.listed && evidence.annotations ? evidence.annotations : null

  // Rule 1: known-destructive is a hard veto over every grant below.
  if (annotations?.destructiveHint === true) return 'review'

  // Rule 2: an explicit decision by the user, either direction, is honoured
  // without consulting the server's self-description.
  if (policy.toolPermission === 'allow') return 'allow'
  if (policy.toolPermission === 'review') return 'review'

  // Rule 3: implicit trust requires a live read-only declaration.
  if (policy.trustReadOnlyHint === true && annotations?.readOnlyHint === true) return 'allow'

  return 'review'
}

/**
 * Merge two annotation listings of the same tool. Merging may only move in
 * the direction of MORE scrutiny: a raising hint counts when ANY occurrence
 * declares it; a lowering hint only when EVERY occurrence does. An absent
 * field says nothing; an explicit `false`/`{}` is a listing that was asked and
 * claimed nothing, and it can therefore veto a lowering hint.
 */
export function mergeAnnotations(previous: ToolAnnotations | undefined, next: ToolAnnotations): ToolAnnotations {
  if (!previous) return { ...next }
  const merged: ToolAnnotations = { ...previous, ...next }
  if (previous.destructiveHint === true || next.destructiveHint === true) {
    merged.destructiveHint = true
  }
  if ('readOnlyHint' in merged) {
    if (previous.readOnlyHint !== true || next.readOnlyHint !== true) merged.readOnlyHint = false
  }
  return merged
}
