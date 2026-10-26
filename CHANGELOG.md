# CHANGELOG — dsh-mcp-registry

## 0.3.12 (2026-10-27)

> 无行为变更。在 0.3.11 基础上把质量门禁从“红但存量”拉回真绿，使发布态与仓库态一致。

- `src/index.ts`：去掉 `nativeIndex` 分支里 `visible` 的冗余初始值（`no-useless-assignment`）；两层 `try/catch` 已覆盖赋值，语义不变。
- `tests/surface-http.test.ts`：假网关的响应体从 `body: any` 改为显式 `GatewayBody` 接口（`no-explicit-any`），`out` 改 `const`（`prefer-const`）；`row?.toolPermissions` 显式处理未找到行。
- 效果：`eslint src tests` 由 3 error 转为 **0 error**（这 3 处在 `4a43f67` 上即存在），与 tsc 0 error / vitest 110/110 一起构成完整门禁。
- 双清单 `package.json` / `dsh-plugin.json` 同步至 **0.3.12**（避免 0.3.10 那类漏同步）。

## 0.3.11 (2026-10-27)

> 0.3.10 已发布但作废（勿用）：包内 `dsh-plugin.json` 的 `version` 仍为 `0.3.9`，与 `package.json` 未同串。0.3.11 仅补齐双清单同步，代码与 0.3.10 一致。

### 修复（issue #1，报告者 shaomou-pek）

- **`/mcp-reg` 任何子命令在真宿主报 `command "mcp-reg" returned unknown result kind "text"`**：宿主 `packages/interaction/commands` 的 `normalizeResult` 只接受 `success` / `error`（该契约自 0.1.7-rc.2 至 0.2.1-rc.3 逐条一致，非宿主回归），而 `src/surface/command.ts` 成功路径一直返回 `kind: 'text'`——自 0.3.0 引入该命令面起，它**从未在真宿主上成功执行过一次**（副作用先落地、返回值这步才抛错，使用者会误判失败而重复执行）。现改为判别联合 `{kind:'success';text?} | {kind:'error';text}`，成功路径返回 `success`；并新增 `failureText()` 保证 `error.text` trim 后非空（宿主对空文案会二次抛错）。
- **`mcp-reg probe` 对 stdio 连接器恒显示 `unknown server (protocol ?)`**：`src/client/stdio-client.ts` 的 `initialize()` 把握手结果写进 `this.info` 却**没有 return**（返回 `Promise<void>`），而 `bridge.doProbe()` 读的是返回值。现与 `http-client` 对齐返回 `this.info`；`SessionLike.initialize` 同时去掉 `| void`，使“吞掉身份”的实现改为在 `tsc` 阶段报错而非运行时静默。

### 测试策略变更（防同类漂移复发）

- 上述两处缺陷都**不是**偶发：`tests/command.test.ts` 手搓 `register` mock 从不经过宿主校验，且 mock 类型把 `kind` 写成宽 `string`；`tests/bridge.test.ts` 的假会话默认返回 `{serverName:'fake'}`，比真实现（返回 void）更“正确”。两层假绿让缺陷活了 8 个版本。
- 新增 `hostNormalize()`——宿主 `normalizeResult` 的等价复刻（三条 throw 文案逐字对齐），所有子命令（含异步 `probe` 分支）结果均须过它；新增 `tests/stdio-initialize.test.ts`，用 `node -e` 内联假 MCP server 起**真子进程**，经真实 `McpStdioSession` 与 `McpBridge.probe()` 断言身份回显。反向验证：把 `success` 改回 `text` 时新用例必红。
- typecheck 0 错；vitest **110/110**（新增 5 例）；tsdown build 产物 `kind:"text"` 计数 0。`eslint` 仍有 3 处**存量**报错（`src/index.ts:168`、`tests/surface-http.test.ts:30/52`，HEAD 上同样红，与本改动无关）。
- 双清单 `package.json` / `dsh-plugin.json` 同步至 **0.3.11**（0.3.10 发版时漏改后者，故重发）。

0.3.8: host enumeration addendum for DSH 0.2.1-rc.3 (declaration-only bump; contract plane zero diff).

## 0.3.7 (2026-10-18)

- hosts: 追加 0.2.1-rc.2 声明面枚举（34/34 @deepseek-ai/* 宿主 peer 逐包 npm 实测 rc.2 在版；本插件不触 ctx.web provider 与 conversation.input.model.label 槽，代码零改动，纯元数据发版；农场 rc.2 格挂账待命）

## 0.3.5 (2026-10-15) — 原生工具懒加载（第三方 LM 连接器的 O(1) 工具 token）

### 新增
- **`lazyNativeTools` 懒加载模式（可选，缺省关）**：在 `system-prompt/assemble` 瀑布层（`await next()` 之后）把非核心原生工具的完整 schema 折叠出常驻 prompt，只保留 `tool_discover`（紧凑目录，name + 截断描述 + active 标记）与 `tool_activate`（按名展开，下一轮以完整 schema 回到 prompt）两个常量元工具。目标：让**无法携带 `mid-conversation-tool-changes` 块的第三方 LM 连接器**也吃到近恒定工具 token（原生 `deferLoading`/`toolUpdate` 机制只在官方 DeepSeek Messages 路由生效，`llm-pi-ai` 会把 `deferLoading` 剥掉、全量透传）。
- **责任边界与 fail-open**：只折叠原生工具——`mcp__*`（bridge 已拥有该面）、注册表自有 4 工具（status/list/call + 两个元工具）、`lazyKeepAlways` 列出的核心集都不动（缺省空列表，即可选保留集为空）；关闭或非数组 tools 载荷直接透传，最坏是现状。工具仍在 `ctx.tools` 注册，执行/TUI/restrict 掩码不受影响，变的只是 prompt 载荷。
- **作用域隔离**：激活状态按 agent 作用域键（`context.scope`/`exec.agent` 共享的 `agent.id`）隔离，纯内存、不落盘、重启回冷；一个 agent 激活不外泄给另一个（对齐 `dsh-mcp-lazy` 的会话隔离）。`enabled: false` 总闸折叠回全量。
- **Config 新字段**（均 volatile，热生效）：`lazyNativeTools`（bool，缺省 false）、`lazyKeepAlways`（string[]，缺省**空列表** `[]`——开启懒加载即隐藏全部非注册表原生工具，贴合「先注入空列表、后续按需注入」；想免发现回合可自行列 `bash/read/write/edit/glob/grep`）、`lazyDescriptionLimit`（number，缺省 160）；TUI 设置面板加 `lazyNativeTools`/`lazyDescriptionLimit` 两行（数组型 `lazyKeepAlways` 无对应 TUI kind，走配置/YAML）。
- **发现引导 system prompt 段**（`buildDiscoveryGuide`）：注册表启用时常驻一段，**直接把当前已注册启用的 MCP 连接器列表（id + 显示名，每次组装从 store 实时重算，不泄 url/token）摊给模型**——模型无需先调 `mcp_registry_status` 就知道有哪些 MCP（即 skill-catalog 的「索引常驻、内容懒加载」，对象换成 MCP：列表常驻、每个连接器的工具 schema 懒到 `mcp_bridge_list_tools`）；懒加载开启时另追加「非核心原生工具已隐藏，用 `tool_discover`/`tool_activate`」。无启用连接器时明说「No MCP connectors …」并保留机制叙述。空文本（注册表关）不产出。挂在 `MCP_SERVERS` 锚点（带 3100 兜底），`inject` 因此含 `systemPrompt`。
- `inject` 加 `systemPrompt`（保证懒加载的 assemble 监听器在任一会话组装前挂上）。
- **懒加载两档开关 `lazyEagerIndex`（bool，volatile，缺省 true=Mode B）**：切换隐藏原生工具的披露形态——开时引导段直接摊开 `名字 (一行摘要)` 名单（skill-catalog 式，免 `tool_discover` 直接 `tool_activate`，常驻 O(n·一行)）；关时名单不预摊、需先 `tool_discover`（常驻 O(1)）。两档工具 schema 仍折叠隐藏，都要 activate 才可调。名单新增 `NativeToolLazyLoader.nativeIndex(scope, visible)`，数据源每次组装从 `ctx.tools.schemas(agent)` 实读（`ToolRegistrar` 加可选 `schemas?`），无首轮预热空窗；宿主无 `schemas` 时回退 `lazy.discover(scope)`。`buildDiscoveryGuide` 的 `GuideInput` 加 `nativeIndex`，懒加载段分 Mode B/A 两支。TUI 面板加 `lazyEagerIndex` 行。仅影响原生工具，MCP 行为不变。

### 验证
- 新增 `tests/lazy.test.ts` 24 例（scopeKeyOf 兜底、disabled 透传、折叠保留 core/own/mcp、作用域隔离、already/unknown 拒绝、discover 截断与 active 标记、forget 清理、buildDiscoveryGuide 六态含 Mode B/A、nativeIndex 过滤/激活后移除/首轮无预热）。typecheck 0 错；vitest 105/105；tsdown build 通过。`tests/surface-http.test.ts` 两处 lint 报错（`any`/`prefer-const`）为先前遗留、与本改动无关。
- 双清单 `package.json` / `dsh-plugin.json` 同步至 **0.3.5**（去 `-local` 后缀，正规补丁版）。

## 0.3.4 (2026-10-10) — 新增「默认放行」权限模式；权限面板宽度修复

### 新增
- **`allow-all`（默认放行）权限模式**：第三种连接器级模式，语义为「默认全部放行，两个否决权保留」——① 服务端申报 destructiveHint 的工具永不静默批准（rule 1 不放宽）；② 逐工具显式标记「审查」仍走 needs_review（opt-out 例外）。贯通全链：`PermissionMode` 枚举 + `resolveToolAccess` 裁决 + `store.updatePolicy` 类型 + 网关 `policy` 校验 + `mcp-reg mode` CLI + `listAuthorized` 投影 + 设置卡/连接器行两处下拉 + zh/en 词典。authz.test 新增 3 用例（默认放行、destructive 否决存活、review 例外）。

### 修复
- **权限面板过宽 / 长描述不截断**：工具行描述 span 已有 ellipsis 样式但缺 `min-width:0`——flex 子项默认 `min-width:auto` 拒绝收缩到内容以下，省略号永不触发，一条长 MCP 描述把整个面板撑宽。描述与工具名 span 均补 `minWidth:'0'`（工具名另加 maxWidth 220px），截断生效；完整文本经 `title` 浮窗气泡展示（原生 tooltip）。
- **needs_review hint 按模式分支**：allow-all 下的审查提示不再误导去 `mcp-reg mode allowlist`，改为指明是 veto（destructive/显式审查）拦下、在权限面板清除。

### 双清单与验证
- `package.json` 与 `dsh-plugin.json` 同步至 0.3.4。typecheck 0 错；vitest 81/81（78 + allow-all 新 3 例）。

### 发布（2026-10-13）
- 0.3.4 上架 npm（`npm publish --registry=https://registry.npmjs.org --tag dsh-0.2.0`），回执 shasum
  `50584a54d74e5ceab8f453ced2ae9c7031bfe9a6` 与 registry 版本级文档逐位一致。
- **`latest` 从 0.2.14 移到 0.3.4**（`npm dist-tag add`）。这是把 0.3.3 已经写进 `engines.dsh` 的收窄
  贯彻到默认解析路径：不带 tag 安装时，≤0.1.6 会被宿主按 `engines.dsh` 拒装——作者确认老线不再支持也不再测。
  历史 tag `dsh-0.1.1` / `dsh-0.1.2` / `dsh-0.1.5` 仍指旧版，仅供取用。
- README 的「版本 ↔ 宿主线」表同步（它之前还写着 `latest = 0.2.2`，且用例数 67 已陈，实为 81）。

## 0.3.3 (2026-10-10) — 收窄支持面：仅 0.1.7 / 0.2.0 rc 线
连接器管理的 Config 区依赖 `configForms`（0.1.7+ 原生可用）；≤0.1.5 无 configForms、只剩只读降级提示，体验不保真。本版把支持面从 `>=0.1.0-0 <0.3.0-0` 收窄到 **0.1.7-rc.1+ 与 0.2.0-rc 线**：`engines.dsh`（两处）改为 `>=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0`；`dsh-client-ui-slots` / `dsh-client-ui-settings` peer 枚举收窄到 `0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`（peer 是宿主 evaluatePluginCompatibility 的 runtime 唯一门禁，故 ≤0.1.5 安装会被拒）。连接器管理网关面（走 webServer）本身跨线可用，但为体验一致不再宣称支持老线。typecheck 0；vitest 78/78。

## 0.3.2 (2026-10-10) — 连接器管理增强（手动添加 / 删除 / 工具树权限面板 / 乐观同步）

### 新增
- **手动添加连接器**：设置卡「添加」折叠表单，ID 必填并即时按 `sanitizeId`（`[a-zA-Z0-9_-]{1,64}`）校验；名称 / 传输方式（stdio / streamable-http）/ 命令 / 参数 / URL / 环境变量 JSON，走网关 `add`。
- **删除连接器**：行内「删除」两段式二次确认 → 网关 `remove`；`store.remove` 同步调 `bridge.forget(id)` 关闭该连接器会话 / stdio 子进程并清 evidence/probeCache/probeInFlight 三表（消除子进程与缓存泄漏，P2-j）。
- **撞 id 拒绝**：`store.add` 对已存在 id 直接拒绝（`id-conflict`），绝不走 upsert 替换（替换会静默丢弃既有 grants/policy，P1-A）。
- **安全着陆**：手动添加记录归一化后强制 `enabled=false + pendingConfirmation=true`（model 归一化对 manual 的默认与此相反），必须探活 + 确认后才启用（P0-1）。
- **工具树权限面板**：连接器行「权限」展开即预读 `bridge.listTools`（名称 / 描述 / readOnlyHint / destructiveHint），逐工具 allow/review；destructive 工具的 allow 选项禁用并标注「授权层强制 review」；已下线工具可清理；预读失败（新连接器落地 disabled+pending 是常态）降级为手输工具名行；整 map 一次 `policy` 提交。
- **投影贯通（P1-D）**：`publicView` 增 `toolPermissions` 全值 map（此前只吐 `grantedTools` 键名、丢 allow/review 值），客户端「放行」芯片按值分流，review 条目不再错显为已放行。
- **网关新方法**：`/mcp-registry/api` 增 `add` / `remove` / `tools`；`policy` 支持整 `toolPermissions` map 直传（经 safeAssign 消毒）；`McpTransportError` → 4xx（对 disabled/pending 连接器取工具返回 400 而非 500，P2-c）。
- **CLI**：`/mcp-reg add <inline json>`（必填 id）/ `remove <id>`。
- **乐观同步（useSyncNow）**：全局默认授权模式（configForms 臂）与连接器 permissionMode/trust（网关臂）改动即时回显，失败按 500/1000/2000ms 三次重试，徽标四态（同步中 / 已同步 / 重试中 N/3 / 失败）；FieldRow 逐字段 opt-in，不波及 enabled/probeTimeout。

### 修复
- **React #310（渲染崩溃）**：`ConnectorManager` 的 `showAdd` 与 `SettingsCard` 的 `useSyncExternalStore`/`useMemo` 此前位于条件早退 return 之后，导致 hook 数量在「加载中/已加载」「scope 迟到/到位」两次渲染间变化 → 卡片整片空白。已把全部 hook 上提到早退之前（外部 store 与 memo 改为内部按 scopeReady 兜底）。
- **添加表单命令框缺失**：stdio 分支误用逗号表达式 `(row(command), row(args))` 只渲染了参数行，且 `connector.command` 恒为空会创建出无可执行命令的坏连接器；改为条件分别渲染命令行与参数/URL 行。
- **传输方式标签错标**：transport 下拉此前误用 `wt('permPanel')`（「权限」），新增独立 `transportLabel`（「传输方式 / Transport」）。

### 双清单与验证
- `package.json` 与 `dsh-plugin.json` 同步至 0.3.2（抹平 0.2.12–0.2.14 历史漂移；`engines.dsh` 维持 `>=0.1.0-0 <0.3.0-0`，`manifestVersion` 不动）。0.3.0 / 0.3.1 为未发布的中间构建，折入本版本。
- typecheck 0 错；vitest 78/78（新增 `surface-http.test` + `command.test` + `store-manage.test`）。
- host farm 五格（0.1.0-rc.8 / 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.2）+ desktop 实装：网关 `add/remove/tools/policy` 全链实测通过（含 P0-1 强制停用+待确认、P1-A 撞 id 拒绝、P2-c tools 4xx、P1-D 整 map 持久化、remove 持久化）；**0.1.0 / 0.1.1 gateway 实测可用**（老线直连，连接器管理照常，无需降级卡，P2-i）；浏览器复验添加表单渲染无 #310、命令框与传输方式标签修复生效。

## 0.2.14 (2026-10-09) — 网关 fetch 有界（8s abort）+ 绝对 URL 优先
Desktop 外壳（Electron）可能与 web origin 不同源：相对 `/mcp-registry/api` 的 fetch 会永久挂起，连接器列表停在加载点（0.2.0 desktop 2026-10-09 实测）。每次调用绑 AbortController，先试绝对同源 URL、失败回退字面相对路径；加载点带可见 origin 诊断。

## 0.2.13 (2026-10-09) — 卡片惰性读 doc 句柄；scoped fiber 可迟到
`configScopeLive` 经 `.get(ID)` 把 configRef（configForms 服务）解包到按命名空间的 doc 句柄；SettingsCard 接受 scope getter 并以 500ms 轮询，使 `['configForms']` fiber 在 slot 工厂之后才解析出来时卡片能自愈。0.1.7 probe：字段渲染、老线提示消失；0.1.0：提示正确、console 干净。

## 0.2.12 (2026-10-09) — configForms 句柄走 scoped-inject 臂
apply 期直接读 `ctx.configForms` 属性在每条线上都是 undefined（0.2.0 desktop 2026-10-09 实测：卡片到处显示老线提示）——句柄只在 `['configForms']` fiber 内实体化，其宿主 ctx 才把服务作为属性携带（cci 教训）。捕获进 configRef，组件先读 ref。≤0.1.5 fiber 永久 pending 但不阻塞其他面。

## 0.2.11 (2026-10-08)

≤0.1.5 炸树修复（legacy-sink 批次 Phase 1）。

### 变更
- **client 顶层 inject 砍除 configForms**（0.2.10 炸树真凶）：`['slots', 'configForms']` → `['slots']`——≤0.1.5 宿主无此服务，顶层声明令整棵 client 树 pending、web boot 拒渲染（M4 批次 0.1.0 假 NOT_FOUND 根因）。configForms 改 configScope() 软读（try/catch，老线 throw 即回退），Config 字段组降级为只读提示（cfgUnavailable），连接器管理走网关不受影响。
- **engines.dsh 放宽**：`>=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0` → `>=0.1.0-0 <0.3.0-0`（三处同步）——≤0.1.5 四老格正式进入支持面（dsh.client.inject providers 同步砍除 dsh-client-ui-settings；peerDependencies 枚举不动）。

## 0.2.10 (2026-10-08)

支持线放宽至 0.1.7 + 门禁补配（M4 设置卡批次 Phase 2）。

### 变更
- **engines.dsh 放宽**：`>=0.2.0-0` → `>=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0`（顶层与 `dsh.engines.dsh` 两处同步）——消除与 dsh-tools peer（早已放行 0.1.7 线）的双门矛盾；0.1.7-rc.2 格实装验收。
- **V3 peer 补配**：`@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-settings` 补进 peerDependencies（15-rc 枚举，optional）——dsh.client.inject 自 scaffold 引用两模块却从未声明背书，verify-package V3 自建仓即红（0.2.9 系绕门禁发）。
- manifest `dsh-plugin.json` 版本 0.2.3→0.2.10（与 package.json 同步，V1 双清单）。

### 边界
- 设置卡不加桥：可安装线（0.1.7/0.2.0）上 configForms 原生可用（三代腰实测），卡原生读写已覆盖；≤0.1.5 需放宽 dsh-tools peer 并验证 tools/TUI/connector 全功能面，独立批次另议。

## 0.2.9 (2026-10-03)

家族面收敛与接管完善（全部真机截图验收）。

### 修复
- **家族节接管保留 tab 层级**：接管节组件补上 tablist + activeId 状态 + tabpanel（thinking-levels FamilySettingsSection 的 tabs-around-pages 模式），首版平铺渲染丢层级的问题已修。
- **tab 样式对齐**：pill 按钮样式逐字照抄 family-tab.tsx（全包边框、选中填充 `--dsw-alias-bg-layer-3`），不再用下划线样式。
- **家族节标题保持原位**：接管节的 label 是「起子插件设置」（family.title 语义，同 session-steward），不是插件名——thinking-levels 被卸载后家族面在原位置原名字保留。
- **接管再武装**：选举不再是一次性——订阅 `settings.section` 变更 + 慢速兜底轮询，家族宿主（如 thinking-levels）运行中被卸载时自动接管，家族面不消失。

### 验证
- typecheck 0 错；vitest 67/67。
- **截图验收（0.2.0-rc.2 真机）**：
  - 有 thinking-levels → 「起子插件设置」内 tablist = 思考档位 + MCP 注册表（无重复独立入口），卡片在 tab 内完整渲染 ✓
  - 卸载 thinking-levels → 「起子插件设置」节原地保留（家族名 + pill tab「MCP 注册表」+ 连接器管理）✓

## 0.2.8 (2026-10-03) — 已弃用

连接器管理 UI + 家族 tab 挂靠首版。被 0.2.9 取代（接管节丢 tab 层级、样式未对齐、无再武装）。

### 修复
- **网关注册**：0.2.0 宿主上 `webServer` 服务（由 `dsh-host-webserver` 插件提供）启动晚于插件 apply——apply 时和 effect 时 `ctx.get('webServer')` 均为 undefined（文件探针实证），0.2.7 的网关从未注册。改为 **cordis 动态 inject** `['webServer']`（thinking-levels modelDirectories 同款模式），服务就绪时回调注册路由；无 web 服务的宿主 inject 永不触发、安全降级。
- **设置面位置**（用户指正）：不再注册独立 section。遵循家族惯例（session-steward 范本）：
  - 常驻 `dsh-family.tab` 贡献卡（thinking-levels 在场时=「起子插件设置」里的 tab）；
  - **家族节接管选举**：宽限期后若无 `dsh-family` 节则以同 id 接管（并发竞争由 ui-slots 同 id 重复注册抛错仲裁）；
  - section 组件的 `hooks.tabs` 由宿主设置壳转化为 **`useTabs` 选择器 hook** 传入（FamilyHooksFace 模式），renderSlot 为可选子席位派发器。

### 新增
- 宿主 `/mcp-registry/api` 网关（dsh-browser-cdp gateway 模式：POST-only、same-origin、`{ok,value|error}` 信封、有界 JSON body）：status/probe/confirm/enable/disable/policy/import/export/call。响应一律脱敏投影。
- 设置卡片连接器管理区：连接器列表（脱敏 target、探活徽章、待确认标记）、模式切换、readOnlyHint 信任开关、grant 芯片（点 × 撤销）+ 回车放行、探活/确认/启停按钮、mcpServers JSON 导入（fail-loud）/导出（脱敏）。

### 验证（0.2.0-rc.2 真机 + 真浏览器）
- API 链路 curl 验收：导入 ✓（字符串 args → `args-not-array` 400 大声拒绝 ✓）、status 脱敏 ✓、confirm/policy(grant+allowlist) ✓、export 脱敏 ✓。

## 0.2.7 (2026-10-03) — 已弃用

网关仍未注册（webServer 晚启动未处理）。被 0.2.8 取代。

## 0.2.4–0.2.6 (2026-10-03)

设置面板补齐（0.2.4：client 半 + 双席位 + configForms 注入修复，卡片可渲染；0.2.5/0.2.6：连接器管理 UI 与类型修复，网关未注册故 UI 无数据）。TUI 设置节（dsh-plugin.json `x-dsh-tui`）自 0.2.4 起随包声明。

## 0.2.2 (2026-10-03)

0.2.0 宿主适配修复版（在 @deepseek-ai/dsh@0.2.0-rc.2 上真机启动验证）。

### 修复
- `inject` 增加 `'commands'`：0.2.0 宿主的 cordis 层对**未注入的服务属性访问直接抛错**（`cannot get property "commands" without inject`），原 `typeof ctx.commands?.register` 守卫在属性访问一步就炸，导致命令面（/mcp-reg）挂载失败。现按 dsh-session-guard 先例声明服务 + 方法级 feature-detect。
- `peerDependencies['@deepseek-ai/dsh-tools']` 放行为 `>=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0`：0.2.0 宿主**强制校验插件 peer 兼容性**并自带 dsh-tools@0.2.0-rc.2；注意 npm semver 的 prerelease tuple 规则——`<0.3.0-0` 宽区间不匹配 0.2.0-rc.2，必须显式写 `>=0.2.0-rc.1` 分支（已用 semver.satisfies 实证）。

### 验证
- typecheck 0 错；vitest 67/67；build。
- **真机**：临时 DSH_HOME + `dsh plugin add`（peer 检查通过）→ `--dump-config` 组合树含 `# == dsh-mcp-registry` 插入行 → `dsh --profile rescue` 真实启动 web（0.2.0-rc.2），启动日志零插件报错。

## 0.2.1 (2026-10-03) — 已弃用

peer 放行版（`>=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0`），但未修 inject 问题，0.2.0 宿主挂载报错。被 0.2.2 取代。

## 0.1.0 (2026-10-03)

首次发布：MCP 连接器受治理注册表（v1 试行版）。

### 新增
- 连接器注册表（stdio / streamable-http），`~/.dsh/mcp-registry/registry.json` 原子写 + 写后回读 + 滚动快照 ≤20 + generation。
- 四级 fail-closed 授权：全局开关 → 连接器 permissionMode（review-all 缺省 / allowlist）→ 工具级 grant → 服务器活声明证据（仅内存）。destructiveHint 硬否决压过显式 allow。
- `mcpServers` JSON 导入：args 非数组 / 混型 / 带空格 command 无 args / proto 键 → **带 id 大声报错**（openhanako 静默丢 args bug 的反向验收）；导入默认 disabled + 待确认。
- `/mcp-reg` 命令：list/probe/import/export/confirm/enable/disable/mode/grant/revoke/trust/call/help。
- agent 工具三件：`mcp_registry_status`（只读脱敏）、`mcp_bridge_list_tools`、`mcp_bridge_call`（review 判定返回 needs_review + grant 指引，不执行）。
- `ctx.provide('dsh-mcp-registry')` 进程内服务面 + webServer `/mcp-registry/api/status` 只读路由（守卫式，headless 宿主安全降级）。
- Windows stdio：PATH/PATHEXT 解析 + `.cmd/.bat` shim 经 `cmd.exe /d /s /c` 逐参引号（移植自 openhanako，67 测试中 9 个专测）。

### 验证
- `npm run typecheck`：0 错误（strict + noUncheckedIndexedAccess）。
- `npm run test`：67/67 通过（authz 表驱动 11、store 9、model 12、import/export 11、stdio-cmdline 9、http 会话 5、bridge 10）。
- `npm run build`：lib/index.js 56KB（esm，dsh-tools external）。
- 未在真实 DSH 宿主上冒烟（verify-headless 属 T9，下版补）。

### 已知边界（诚实不粉饰）
- review 判定 = 诚实拒绝（DSH 0.1.7 无每调用审批设施）。
- `/mcp-reg probe|call` 依赖宿主 await 命令 handler；严格同步宿主无回显。
- 无 OAuth、无 SSE 旧传输、无自动探活循环、无物理删除、无客户端 UI 卡片。
- stdio 子进程在连接器 disable 后不主动回收（重启插件回收）。
