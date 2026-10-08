/**
 * dsh-mcp-registry — web client half (settings + connector management).
 *
 * Mounts, all self-registered (no third-party seat provider required):
 *  1. `settings.section` — OUR OWN top-level settings nav entry ("MCP 注册表")
 *     rendering the full card. The dsh-thinking-levels pattern (its
 *     src/client/index.ts:199-209): register the section entry with the card
 *     as the section component. This is the family-settings surface that
 *     registers ITSELF instead of waiting for someone else's seat.
 *  2. `plugins.bundle.config` — the plugin-detail-page keyed seat, declared
 *     by both the 0.1.7 and 0.2.0 hosts.
 *
 * Connector management rides the host gateway (/mcp-registry/api, POST-only,
 * same-origin, {ok,value|error} envelope — the dsh-browser-cdp gateway
 * pattern): status/probe/policy/import/export/call. All responses carry
 * redacted projections only.
 *
 * Registration lessons from dsh-thinking-levels (index.ts:92-98):
 *  - 0.2.10 declared `configForms` in this module's `inject` list so the
 *     loader guaranteed the service started before apply(); that silently
 *     killed the WHOLE client tree on ≤0.1.5 hosts (the service does not
 *     exist there — the fiber pends forever and web boot refuses to render,
 *     M4 batch measured 2026-10-08). 0.2.11 reads it SOFT instead:
 *     `configScope()` below try/catches a `ctx.configForms` property read,
 *     which throws-and-falls-back on old lines and resolves normally on
 *     0.1.7+. The Config field groups degrade to a read-only notice; the
 *     connector manager rides the gateway and never needed configForms.
 *  - package.json `dsh.client.inject` names the PROVIDER modules
 *     (dsh-client-ui-slots → slots).
 *
 * React comes from the host profile via require(); plain createElement (CJS
 * ModuleLoader build); bilingual labels from an inline zh/en dict.
 */
declare function require(id: string): any

const React = require('react')

const ID = 'dsh-mcp-registry'
const API = '/mcp-registry/api'

// ── bilingual labels (zh source of truth) ───────────────────────────────────
const DICT: Record<string, { zh: string; en: string }> = {
  famTitle: { zh: 'MCP 注册表', en: 'MCP Registry' },
  cfgUnavailable: {
    zh: '配置字段此宿主线不可读（configForms 缺席，老线常态）——连接器管理不受影响；配置可经 cordis.patch.yml 本条目 config 修改。',
    en: 'Config fields unreadable on this host line (no configForms) — connector management is unaffected; edit this entry\'s config in cordis.patch.yml.',
  },
  familyTitle: { zh: '起子插件设置', en: 'Plugin Family Settings' },
  gCore: { zh: '注册表与授权', en: 'Registry & authorization' },
  enabled: { zh: '总开关', en: 'Master switch' },
  enabledDesc: { zh: '关闭后 mcp_bridge_call 拒绝调用、状态工具报告禁用（注册表数据不受影响）。', en: 'Off = mcp_bridge_call refuses and the status tool reports disabled (registry data is untouched).' },
  defaultPermissionMode: { zh: '默认授权模式', en: 'Default permission mode' },
  defaultPermissionModeDesc: { zh: 'review-all（安全默认）：agent 调用一律返回 needs_review，直到你显式放行；allowlist：仅显式放行的工具静默执行。', en: 'review-all (safe default): agent calls return needs_review until granted; allowlist: only granted tools run silently.' },
  probeTimeoutMs: { zh: '探活超时 (ms)', en: 'Probe timeout (ms)' },
  probeTimeoutMsDesc: { zh: '一次 MCP initialize 握手的超时。', en: 'Timeout for one MCP initialize handshake.' },
  modeReviewAll: { zh: '全部审查', en: 'Review all' },
  modeAllowlist: { zh: '白名单放行', en: 'Allowlist' },
  gConnectors: { zh: '连接器', en: 'Connectors' },
  refresh: { zh: '刷新', en: 'Refresh' },
  importBtn: { zh: '导入', en: 'Import' },
  importTitle: { zh: '导入 mcpServers JSON（导入后默认停用+待确认）', en: 'Import mcpServers JSON (lands disabled + unconfirmed)' },
  importConfirm: { zh: '确认导入', en: 'Import' },
  importCancel: { zh: '取消', en: 'Cancel' },
  exportBtn: { zh: '导出（脱敏）', en: 'Export (redacted)' },
  empty: { zh: '还没有连接器 — 粘贴 mcpServers JSON 导入，或在会话里运行 /mcp-reg。', en: 'No connectors yet — paste mcpServers JSON to import, or run /mcp-reg in a session.' },
  damaged: { zh: '注册表文件损坏（fail-closed）：', en: 'Registry file damaged (fail-closed): ' },
  probe: { zh: '探活', en: 'Probe' },
  confirm: { zh: '确认', en: 'Confirm' },
  enable: { zh: '启用', en: 'Enable' },
  disable: { zh: '停用', en: 'Disable' },
  grants: { zh: '放行', en: 'grants' },
  grantPlaceholder: { zh: '输入工具名后回车=放行', en: 'tool name + Enter = grant' },
  trust: { zh: '信任 readOnlyHint', en: 'trust readOnlyHint' },
  alive: { zh: '存活', en: 'alive' },
  down: { zh: '失败', en: 'down' },
  unprobed: { zh: '未探活', en: 'unprobed' },
  unconfirmed: { zh: '待确认', en: 'unconfirmed' },
  working: { zh: '…', en: '…' },
}

function wt(key: string): string {
  let lang = 'en'
  try { lang = (navigator.language || 'en').startsWith('zh') ? 'zh' : 'en' } catch { /* non-browser */ }
  const entry = DICT[key]
  return entry ? (lang === 'zh' ? entry.zh : entry.en) : key
}

// ── field model for the global Config group ─────────────────────────────────
interface FieldSpec {
  k: string
  kind: 'bool' | 'num' | 'sel'
  lk: string
  dk?: string
  min?: number
  max?: number
  step?: number
  options?: string[]
  optionLabels?: Record<string, string>
}

const FIELD_GROUPS: Array<{ gk: string; fields: FieldSpec[] }> = [
  { gk: 'gCore', fields: [
    { k: 'enabled', kind: 'bool', lk: 'enabled', dk: 'enabledDesc' },
    {
      k: 'defaultPermissionMode', kind: 'sel', lk: 'defaultPermissionMode', dk: 'defaultPermissionModeDesc',
      options: ['review-all', 'allowlist'],
      optionLabels: { 'review-all': 'modeReviewAll', 'allowlist': 'modeAllowlist' },
    },
    { k: 'probeTimeoutMs', kind: 'num', min: 200, max: 30000, step: 100, lk: 'probeTimeoutMs', dk: 'probeTimeoutMsDesc' },
  ] },
]

/** Services required by the browser half (lesson from 0.2.3 — see header).
 *  `configForms` must NOT be declared here: it is generation-exclusive
 *  (0.1.7+) and a top-level declaration pends the whole client tree on
 *  ≤0.1.5 hosts (0.2.10 tree-killer, M4 batch). Soft-read via configScope. */
export const inject = ['slots']

function configScope(ctx: any): any {
  try {
    return typeof ctx.configForms?.get === 'function' ? ctx.configForms.get(ID) : undefined
  } catch {
    return undefined
  }
}

// ── gateway client ──────────────────────────────────────────────────────────
async function api(method: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const payload: any = await res.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || payload.ok !== true) {
    const message = payload && payload.error ? payload.error.message : `HTTP ${res.status}`
    throw new Error(message)
  }
  return payload.value
}

// ── small style atoms ───────────────────────────────────────────────────────
const BTN = {
  font: 'inherit', fontSize: '12px', color: 'inherit', cursor: 'pointer',
  background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
  borderRadius: '8px', padding: '3px 10px',
} as const
const INPUT = {
  font: 'inherit', color: 'inherit', fontSize: '12px',
  background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
  borderRadius: '8px', padding: '3px 8px',
} as const
const CHIP = {
  ...BTN, cursor: 'default', padding: '1px 8px', borderRadius: '999px', marginRight: '4px',
} as const
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' } as const

// ── global Config fields card (unchanged shape from 0.2.4) ──────────────────
function GroupBlock(props: any): any {
  const h = React.createElement
  return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))', paddingTop: '6px' } },
    h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))', padding: '2px 0 4px' } }, wt(props.group.gk)),
    props.group.fields.map(function (f: FieldSpec) { return h(FieldRow, { key: f.k, f: f, value: props.value, writable: props.writable, scope: props.scope }) }),
  )
}

function FieldRow(props: any): any {
  const f: FieldSpec = props.f
  const value = props.value
  const writable = props.writable
  const scope = props.scope
  const h = React.createElement
  const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
  const label = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
    h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, wt(f.lk)),
    f.dk ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))', lineHeight: 1.5 } }, wt(f.dk)) : null)

  if (f.kind === 'bool') {
    return h('div', { style: rowStyle }, label,
      h('input', { type: 'checkbox', checked: value[f.k] === true, disabled: !writable,
        onChange: function (this: any, e: any) { void scope.set(f.k, e.target.checked) } }))
  }
  if (f.kind === 'sel') {
    return h('div', { style: rowStyle }, label,
      h('select', { value: String(value[f.k] ?? (f.options as string[])[0]), disabled: !writable, style: INPUT,
        onChange: function (this: any, e: any) { void scope.set(f.k, e.target.value) } },
        (f.options as string[]).map(function (o) {
          const labelKey = f.optionLabels?.[o]
          return h('option', { key: o, value: o }, labelKey ? wt(labelKey) : o)
        })))
  }
  return h('div', { style: rowStyle }, label, h(NumInput, { f: f, v: value[f.k], writable: writable, scope: scope }))
}

function NumInput(props: any): any {
  const f = props.f
  const h = React.createElement
  const draft = React.useState(props.v === undefined || props.v === null ? '' : String(props.v))
  const v = draft[0]
  const setV = draft[1]
  React.useEffect(function () { setV(props.v === undefined || props.v === null ? '' : String(props.v)) }, [props.v])
  return h('input', { type: 'number', min: f.min, max: f.max, step: f.step, value: v, disabled: !props.writable, style: { ...INPUT, width: '96px' },
    onChange: function (this: any, e: any) { setV(e.target.value) },
    onBlur: function (this: any) {
      if (v === '') return
      let n = Number(v)
      if (!isFinite(n)) return
      n = Math.round(n / (f.step || 1)) * (f.step || 1)
      if (f.min !== undefined) n = Math.max(f.min, n)
      if (f.max !== undefined) n = Math.min(f.max, n)
      void props.scope.set(f.k, n)
    } })
}

// ── connector manager ───────────────────────────────────────────────────────
interface ConnectorRow {
  id: string
  transport: string
  target: string
  enabled: boolean
  pendingConfirmation: boolean
  permissionMode: string
  grantedTools: string[]
  trustReadOnlyHint?: boolean
  probe: { ok: boolean; code?: string; message?: string; latencyMs?: number } | null
}

function ConnectorManager(): any {
  const h = React.createElement
  const [rows, setRows] = React.useState(null as ConnectorRow[] | null)
  const [damaged, setDamaged] = React.useState(null as string | null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [showImport, setShowImport] = React.useState(false)
  const [importText, setImportText] = React.useState('')
  const [exportText, setExportText] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const refresh = React.useCallback(function (): void {
    api('status').then(function (value: any) {
      setDamaged(value.damaged ? `${value.damageReason ?? ''} — ${value.corruptFile ?? ''}` : null)
      setRows(value.connectors ?? [])
      setError('')
    }).catch(function (e: Error) { setError(e.message) })
  }, [])
  React.useEffect(function () { refresh() }, [refresh])

  const act = React.useCallback(function (method: string, body: Record<string, unknown>, key: string): void {
    setBusy(key)
    api(method, body).then(function () {
      setError('')
      refresh()
    }).catch(function (e: Error) { setError(e.message) }).finally(function () { setBusy('') })
  }, [refresh])

  if (damaged) {
    return h('div', { style: { padding: '8px 0', fontSize: '12px', color: '#e6a23c' } }, wt('damaged') + damaged)
  }
  if (rows === null) {
    return h('div', { style: { padding: '8px 0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))' } }, '…')
  }

  const toolbar = h('div', { style: { display: 'flex', gap: '6px', padding: '4px 0' } },
    h('button', { style: BTN, onClick: function () { refresh() } }, wt('refresh')),
    h('button', { style: BTN, onClick: function () { setShowImport(!showImport); setExportText('') } }, wt('importBtn')),
    h('button', {
      style: BTN,
      onClick: function () {
        api('export').then(function (v: any) { setExportText(v.json ?? ''); setShowImport(false) }).catch(function (e: Error) { setError(e.message) })
      },
    }, wt('exportBtn')))

  const importPanel = showImport
    ? h('div', { style: { display: 'grid', gap: '6px', padding: '6px 0' } },
        h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))' } }, wt('importTitle')),
        h('textarea', {
          value: importText,
          placeholder: '{"mcpServers":{"example":{"command":"npx","args":["-y","mcp-server-example"]}}}',
          style: { ...MONO, minHeight: '90px', padding: '8px', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', color: 'inherit' },
          onChange: function (this: any, e: any) { setImportText(e.target.value) },
        }),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', {
            style: BTN,
            onClick: function () {
              setBusy('import')
              api('import', { json: importText }).then(function (v: any) {
                setImportText('')
                setShowImport(false)
                setError('')
                setNotice(`${wt('importBtn')}: ${(v.imported ?? []).length}`)
                refresh()
              }).catch(function (e: Error) { setError(e.message) }).finally(function () { setBusy('') })
            },
          }, wt('importConfirm') + (busy === 'import' ? wt('working') : '')),
          h('button', { style: BTN, onClick: function () { setShowImport(false) } }, wt('importCancel'))))
    : null

  const exportPanel = exportText !== ''
    ? h('textarea', {
        readOnly: true, value: exportText,
        style: { ...MONO, minHeight: '90px', width: '100%', padding: '8px', background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px', color: 'inherit' },
      })
    : null

  const list = rows.length === 0
    ? h('div', { style: { padding: '6px 0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))' } }, wt('empty'))
    : (rows as ConnectorRow[]).map(function (row: ConnectorRow): any { return h(ConnectorCard, { key: row.id, row: row, act: act, busy: busy }) })

  return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))', paddingTop: '6px' } },
    h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))', padding: '2px 0 4px' } }, wt('gConnectors')),
    toolbar,
    importPanel,
    exportPanel,
    error !== '' ? h('div', { style: { fontSize: '12px', color: '#f56c6c', padding: '4px 0', whiteSpace: 'pre-wrap' } }, error) : null,
    notice !== '' ? h('div', { style: { fontSize: '12px', color: '#67c23a', padding: '4px 0' } }, notice) : null,
    list)
}

function probeBadge(row: ConnectorRow): { text: string; color: string } {
  if (!row.probe) return { text: wt('unprobed'), color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))' }
  return row.probe.ok
    ? { text: `${wt('alive')} ${row.probe.latencyMs ?? ''}ms`, color: '#67c23a' }
    : { text: `${wt('down')} ${row.probe.code ?? ''}`, color: '#f56c6c' }
}

function ConnectorCard(props: any): any {
  const row: ConnectorRow = props.row
  const act = props.act
  const busy = props.busy
  const h = React.createElement
  const [grantText, setGrantText] = React.useState('')
  const badge = probeBadge(row)
  const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
    h('span', { style: { ...MONO, fontWeight: 600 } }, row.id),
    h('span', { style: { ...CHIP, fontSize: '11px' } }, row.transport),
    h('span', { style: MONO }, row.target),
    row.pendingConfirmation ? h('span', { style: { ...CHIP, fontSize: '11px', color: '#e6a23c' } }, wt('unconfirmed')) : null,
    h('span', { style: { fontSize: '11px', color: badge.color } }, badge.text))
  const policyLine = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '3px 0' } },
    h('select', {
      value: row.permissionMode, style: INPUT,
      onChange: function (this: any, e: any) { act('policy', { id: row.id, permissionMode: e.target.value }, row.id + ':mode') },
    },
      h('option', { value: 'review-all' }, wt('modeReviewAll')),
      h('option', { value: 'allowlist' }, wt('modeAllowlist'))),
    h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' } },
      h('input', {
        type: 'checkbox',
        checked: row.trustReadOnlyHint === true,
        title: wt('trust'),
        onChange: function () { act('policy', { id: row.id, trustReadOnlyHint: !(row.trustReadOnlyHint === true) }, row.id + ':trust') },
      }),
      wt('trust')),
    h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))' } }, wt('grants') + ':'),
    row.grantedTools.length === 0
      ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))' } }, '—')
      : row.grantedTools.map(function (tool: string): any {
          return h('span', {
            key: tool, style: { ...CHIP, cursor: 'pointer', fontSize: '11px' }, title: wt('grants'),
            onClick: function () { act('policy', { id: row.id, revoke: tool }, row.id + ':revoke:' + tool) },
          }, tool + ' ×')
        }),
    h('input', {
      value: grantText, placeholder: wt('grantPlaceholder'), style: { ...INPUT, width: '160px' },
      onChange: function (this: any, e: any) { setGrantText(e.target.value) },
      onKeyDown: function (this: any, e: any) {
        if (e.key === 'Enter' && grantText.trim() !== '') {
          act('policy', { id: row.id, grant: grantText.trim() }, row.id + ':grant')
          setGrantText('')
        }
      },
    }))
  const actions = h('div', { style: { display: 'flex', gap: '6px', padding: '3px 0' } },
    h('button', { style: BTN, onClick: function () { act('probe', { id: row.id }, row.id + ':probe') } }, wt('probe') + (busy === row.id + ':probe' ? wt('working') : '')),
    row.pendingConfirmation
      ? h('button', { style: BTN, onClick: function () { act('confirm', { id: row.id }, row.id + ':confirm') } }, wt('confirm'))
      : null,
    h('button', {
      style: BTN,
      onClick: function () { act(row.enabled ? 'disable' : 'enable', { id: row.id }, row.id + ':toggle') },
    }, row.enabled ? wt('disable') : wt('enable')))
  return h('div', { style: { borderBottom: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.2))', padding: '6px 0' } },
    head, policyLine, actions)
}

// ── the full card ────────────────────────────────────────────────────────────
function SettingsCard(props: any): any {
  const scope = props.scope
  const h = React.createElement
  if (!scope || typeof scope.getSnapshot !== 'function') {
    return h('div', { style: { padding: '8px 0', fontSize: '12px', color: 'var(--dsh-alias-label-tertiary, rgba(127,127,127,.8))' } },
      wt('cfgUnavailable'))
  }
  const snapshot = React.useSyncExternalStore(
    function (listener: () => void) { return scope.subscribe(listener) },
    function () { return scope.getSnapshot() },
  )
  const value = snapshot.value || {}
  const writable = snapshot.writable === true
  return h('div', { style: { display: 'grid', gap: '8px' } },
    FIELD_GROUPS.map(function (group) {
      return h(GroupBlock, { key: group.gk, group: group, value: value, writable: writable, scope: scope })
    }),
    h(ConnectorManager, { key: 'connectors' }))
}

// ── mounting: own top-level section + plugin detail page ────────────────────
function apply(ctx: any): void {
  if (!ctx.slots || typeof ctx.slots.inject !== 'function') return

  // Family settings tab: a TAB inside the shared 起子插件设置 section
  // (the `dsh-family.tab` child slot provided by dsh-thinking-levels —
  // thinking-levels index.ts:199-209 declares the section + children seat).
  // This is where the user expects the card; 0.2.3 failed here only because
  // configForms was not injected, so the card registered nothing — fixed by
  // the inject declaration above.
  ctx.slots.inject('dsh-family.tab', function (): any {
    return ctx.slots.register({
      name: 'dsh-family.tab',
      id: ID,
      order: 40,
      label: function (): string { return wt('famTitle') },
      inject: function (): any { return { scope: configScope(ctx) } },
    }, SettingsCard)
  }, 'dsh-mcp-registry: family settings tab')

  // 2) Plugin-detail-page config card (keyed by package name).
  ctx.slots.inject('plugins.bundle.config', function (): any {
    return ctx.slots.register({
      name: 'plugins.bundle.config',
      key: ID,
      inject: function (): any { return { scope: configScope(ctx) } },
    }, SettingsCard)
  }, 'dsh-mcp-registry: plugins-page config card')

  // 3) Family-host election fallback (the dsh-session-steward pattern): after
  //    a grace period, if nobody has registered the shared family section
  //    (id `dsh-family`, normally dsh-thinking-levels or dsh-session-guard),
  //    claim it OURSELVES with the same id and the same `dsh-family.tab`
  //    child slot, rendering every contributor card generically. When the
  //    section already exists this is a no-op; a concurrent election race is
  //    arbitrated by ui-slots throwing on the duplicate id — first wins.
  const familyTabsHooks = makeFamilyTabsHooks(ctx.slots)
  ctx.effect?.(function (): () => void {
    let claimed: unknown
    let done = false
    const tryClaim = function (): void {
      if (done) return
      // Already hosted (thinking-levels / guard / steward present) → stand by;
      // the re-arm triggers below keep watch for that host going away.
      let hosted: boolean
      try {
        const sections = typeof ctx.slots.entries === 'function' ? ctx.slots.entries('settings.section') : []
        hosted = sections.some(function (e: any) { return e?.options?.id === FAMILY_SECTION_ID })
      } catch { return }
      if (hosted) return
      try {
        claimed = ctx.slots.register({
          name: 'settings.section',
          id: FAMILY_SECTION_ID,
          order: 40,
          // The fallback host keeps the family surface IN ITS ORIGINAL PLACE:
          // the section keeps the family title (起子插件设置), not our plugin
          // name — same semantic as dsh-session-steward's family.title.
          label: function (): string { return wt('familyTitle') },
          inject: function (): any { return { hooks: { tabs: familyTabsHooks } } },
          children: { 'dsh-family.tab': { kind: 'list', scope: 'root' } },
        }, FamilySection)
        done = true
      } catch {
        // Lost an election race (the winner serves the whole family).
        done = true
      }
    }
    const initial = setTimeout(tryClaim, FAMILY_HOST_GRACE_MS)
    // Re-arm: when the hosting section disappears at runtime (its plugin is
    // uninstalled/updated), the family surface must KEEP ITS PLACE — claim on
    // the slot change and on a slow interval as a belt-and-braces.
    const offChange = typeof ctx.slots.subscribe === 'function'
      ? ctx.slots.subscribe('settings.section', function (): void { setTimeout(tryClaim, 300) })
      : undefined
    const interval = setInterval(tryClaim, 5000)
    return function (): void {
      clearTimeout(initial)
      clearInterval(interval)
      if (typeof offChange === 'function') offChange()
      if (typeof claimed === 'function') (claimed as () => void)()
    }
  }, 'dsh-mcp-registry: family fallback host')
}

/** 家族节固定 id（与 thinking-levels / guard / steward 严格一致）。 */
const FAMILY_SECTION_ID = 'dsh-family'
/** 家族子席位 key（与 thinking-levels 的声明严格一致）。 */
const FAMILY_CHILD_KEY = 'dsh-family.tab'
/** 接管宽限期：guard 2000ms、steward 2600ms 先试，本插件最后兜底。 */
const FAMILY_HOST_GRACE_MS = 3200

interface FamilyTabEntry { id: string; order: number; label: string }

/** 家族 tab 账本投影（照 dsh-session-steward 的 makeFamilyTabsHooks）。 */
function makeFamilyTabsHooks(slots: any): {
  getSnapshot: () => readonly FamilyTabEntry[]
  subscribe: (listener: () => void) => () => void
} {
  let version = -1
  let tabs: readonly FamilyTabEntry[] = []
  return {
    getSnapshot: function (): readonly FamilyTabEntry[] {
      const next = slots.getVersion(FAMILY_CHILD_KEY)
      if (next !== version) {
        version = next
        tabs = slots.entries(FAMILY_CHILD_KEY).map(function (entry: any): FamilyTabEntry {
          const raw = entry?.options?.label
          let label = String(entry?.options?.id ?? '')
          if (typeof raw === 'function') {
            try { label = String(raw() ?? label) } catch { /* bad contributor label */ }
          } else if (typeof raw === 'string') {
            label = raw
          }
          return { id: entry?.options?.id ?? '', order: entry?.options?.order ?? 0, label: label }
        }).sort(function (a: FamilyTabEntry, b: FamilyTabEntry) { return a.order - b.order })
      }
      return tabs
    },
    subscribe: function (listener: () => void): () => void { return slots.subscribe(FAMILY_CHILD_KEY, listener) },
  }
}

/**
 * 家族节接管组件：纯通用渲染 —— 把 `dsh-family.tab` 账本里的每张贡献卡
 * （含本插件自己的）按 order 依次 renderSlot。照 dsh-session-steward 的
 * StewardFamilySection；renderSlot 由宿主设置壳经 section inject 传入。
 */
function FamilySection(props: any): any {
  const h = React.createElement
  try {
    // The settings shell transforms the inject face: `hooks.tabs` arrives as a
    // bound `useTabs` selector hook (the thinking-levels FamilyHooksFace
    // pattern), and renderSlot as an optional child-slot dispatcher.
    const useTabs = props.useTabs
    const renderSlot = typeof props.renderSlot === 'function' ? props.renderSlot : null
    const contributors: readonly FamilyTabEntry[] = typeof useTabs === 'function'
      ? useTabs(function (value: readonly FamilyTabEntry[]) { return value })
      : []
    // Keep the TAB HIERARCHY in the fallback host too (the user-visible
    // regression in the flattened first cut): tablist + activeId state +
    // one tabpanel rendering the active contributor via renderSlot — the
    // thinking-levels FamilySettingsSection tabs-around-pages pattern.
    const draft = React.useState(contributors[0]?.id ?? '')
    const activeId = draft[0]
    const setActiveId = draft[1]
    const exists = contributors.some(function (c: FamilyTabEntry) { return c.id === activeId })
    const effective = exists ? activeId : (contributors[0]?.id ?? '')
    const tabBar = h('div', { role: 'tablist', style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
      contributors.map(function (c: FamilyTabEntry): any {
        const active = c.id === effective
        // Pill styling verbatim from dsh-thinking-levels family-tab.tsx —
        // fully-enclosed button, filled when active.
        return h('button', {
          key: c.id, type: 'button', role: 'tab', 'aria-selected': active,
          style: {
            appearance: 'none',
            font: 'inherit',
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            background: active ? 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))' : 'none',
            color: 'var(--dsw-alias-label-primary, inherit)',
            borderRadius: '8px',
            padding: '5px 12px',
            fontSize: '13px',
          },
          onClick: function (): void { setActiveId(c.id) },
        }, c.label)
      }))
    const panel = renderSlot && effective !== ''
      ? h('div', {}, renderSlot('dsh-family.tab', {}, { only: effective, fallback: null }))
      : null
    return h('div', { style: { display: 'grid', gap: '10px' } },
      contributors.length > 0 ? tabBar : null,
      panel)
  } catch (e) {
    return h('div', { style: { color: '#f56c6c', fontSize: '12px' } }, 'family section error: ' + (e as Error).message)
  }
}

export const name = ID
export { apply }
