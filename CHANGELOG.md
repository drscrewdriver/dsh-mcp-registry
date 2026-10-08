# CHANGELOG — dsh-mcp-registry

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
