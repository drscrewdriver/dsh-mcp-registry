import z from '@deepseek-ai/schemastery'

// ── 0.1.7 declarative settings ─────────────────────────────────────────────
// The Config schema IS the settings form. Only `.volatile()` fields are
// projected into the auto-generated settings page; a volatile-only change is
// delivered as a live ref update plus one `loader/volatile-update` event, so
// the getters in index.ts see new values without a plugin remount.
//
// The global kill switch defaults to ON here but the registry itself still boots fail-closed
// anyway: a damaged registry file disables every connector regardless of this
// switch (see core/store.ts).
export const Config = z.object({
  enabled: z
    .boolean()
    .description('Global switch for the MCP registry and every bridged tool call. Off = mcp_bridge_call refuses and the status tool reports disabled.')
    .volatile(),
  defaultPermissionMode: z
    .union(['review-all', 'allowlist', 'allow-all'])
    .description('Permission mode for connectors that do not set their own. review-all (safe default): every agent call returns needs_review until you grant tools. allowlist: only explicitly granted tools run silently (and read-only-trusted tools when trustReadOnlyHint is on). allow-all: every tool runs by default, except server-declared destructive tools and tools explicitly marked for review.')
    .volatile(),
  probeTimeoutMs: z
    .number()
    .min(200)
    .max(30000)
    .step(100)
    .description('Timeout for one MCP initialize probe (manual, via /mcp-reg probe).')
    .volatile(),
  // ── native tool lazy loading ───────────────────────────────────────────
  // Folds model-facing NATIVE DSH tool schemas (shell, fs, search, …) out of
  // the standing prompt and reveals them on demand through two meta-tools, so
  // a third-party LM connector that cannot do mid-conversation tool changes
  // still pays a near-constant tool cost. MCP tools (mcp__*) are NOT touched —
  // the bridge already owns that surface. Off by default; enabling is opt-in.
  lazyNativeTools: z
    .boolean()
    .description('Lazy-load native tools: hide non-core tool schemas from the prompt and reveal them via tool_discover / tool_activate. Does not affect MCP tools or the registry bridge tools.')
    .volatile()
    .default(false),
  lazyEagerIndex: z
    .boolean()
    .description('When lazyNativeTools is on: true (default) injects a compact name+one-line index of hidden native tools into the prompt so the model can tool_activate directly (Mode B); false keeps the standing prompt O(1) and requires tool_discover first (Mode A).')
    .volatile()
    .default(true),
  lazyKeepAlways: z
    .array(z.string())
    .description('Native tool names that stay eagerly declared even when lazy loading is on. Empty (the default) hides every non-registry native tool until tool_activate reveals it — the agent pays one tool_discover/activate round-trip before it can use, say, bash. List the core (bash, read, write, edit, glob, grep) to skip that round-trip.')
    .volatile()
    .default([]),
  lazyDescriptionLimit: z
    .number()
    .min(20)
    .max(2000)
    .step(10)
    .description('Max characters of each tool description shown in the tool_discover catalog (truncated). Full schemas return on activation.')
    .volatile()
    .default(160),
  // ── plain (non-TLS) http on the LAN ────────────────────────────────────
  // The connector rule is "https anywhere, plain http loopback only". That is
  // correct as a default and wrong as a wall: a personal LAN machine is not
  // supposed to mint a hostname and a certificate. So the wall becomes a grant
  // list — EMPTY means the old behaviour byte-for-byte. Entries: exact host
  // (`192.168.1.23` / `nas.lan`), IPv4 CIDR no wider than /8 (`192.168.1.0/24`),
  // or one-label wildcard (`*.lan`). Link-local (169.254.0.0/16, incl. the cloud
  // metadata address) and 0.0.0.0 can never be granted. Judged at write time for
  // early errors AND at connect time as the real boundary, because a hand-edited
  // registry.json bypasses the former. A plaintext route also carries bearer
  // tokens in the clear — the connector row says so when it matches.
  plainHttpAllowlist: z
    .array(z.string())
    .description('Hosts allowed for plain (non-TLS) http connectors: exact host, IPv4 CIDR (no wider than /8), or "*.suffix". Empty (the default) keeps the loopback-only rule. 169.254.0.0/16 and 0.0.0.0 can never be listed.')
    .volatile()
    .default([]),
})
