import z from '@deepseek-ai/schemastery'

// ── 0.1.7 declarative settings ─────────────────────────────────────────────
// The Config schema IS the settings form. Only `.volatile()` fields are
// projected into the auto-generated settings page; a volatile-only change is
// delivered as a live ref update plus one `loader/volatile-update` event, so
// the getters in index.ts see new values without a plugin remount.
//
// The global kill switch defaults to ON here but the registry boots fail-closed
// anyway: a damaged registry file disables every connector regardless of this
// switch (see core/store.ts).
export const Config = z.object({
  enabled: z
    .boolean()
    .description('Global switch for the MCP registry and every bridged tool call. Off = mcp_bridge_call refuses and the status tool reports disabled.')
    .volatile(),
  defaultPermissionMode: z
    .union(['review-all', 'allowlist'])
    .description('Permission mode for connectors that do not set their own. review-all (safe default): every agent call returns needs_review until you grant tools. allowlist: only explicitly granted tools run silently (and read-only-trusted tools when trustReadOnlyHint is on).')
    .volatile(),
  probeTimeoutMs: z
    .number()
    .min(200)
    .max(30000)
    .step(100)
    .description('Timeout for one MCP initialize probe (manual, via /mcp-reg probe).')
    .volatile(),
})
