# HANDOVER — dsh-mcp-registry

> 维护者交接文档。改代码前先读完「坑位清单」；架构细节见 `docs/ARCH.md`（T2 扩展时创建）。

## 0. 一句话

一个 DSH 插件：**MCP 连接器的受治理注册表**——登记 stdio / streamable-http 连接器，
四级 fail-closed 授权（全局开关 → 连接器 permissionMode → 工具级 grant → 服务器活声明证据），
agent 经 `mcp_bridge_call` 调用（review 判定诚实拒绝而非伪装放行），人类经 `/mcp-reg` 命令治理。

## 1. 身份

| 项 | 值 |
|---|---|
| 包名 / patch row id | `dsh-mcp-registry`（两者必须相等，否则入口静默失效） |
| inject | `['tools', 'commands']`（0.2.0 宿主：未注入的服务属性访问会抛错，见坑位 12） |
| 数据文件 | `~/.dsh/mcp-registry/registry.json`（损坏时保留 `registry.json.corrupt-<ts>`） |
| 快照 | 同目录 `registry.<ts>.bak`，滚动保留 20 个 |
| 命名空间 | agent 工具 `mcp_registry_status` / `mcp_bridge_list_tools` / `mcp_bridge_call`；命令 `/mcp-reg`；服务 `dsh-mcp-registry`；HTTP `/mcp-registry/api/status` |
| 依赖 | 运行时仅 `@deepseek-ai/schemastery`；peer `@deepseek-ai/dsh-tools`（defineTool） |

## 2. 结构

```
src/
  index.ts        入口 apply()：装配 + 守卫式 surface（tools/commands/provide/webServer）
  config.ts       Config schema（volatile: enabled / defaultPermissionMode / probeTimeoutMs）
  types.ts        结构化 ctx 类型（不 import cordis）
  authz.ts        ★ resolveToolAccess 唯一判定缝（规则序 1-3）+ mergeAnnotations
  bridge.ts       McpBridge：会话管理 + 内存证据表 + needs_review 语义 + probeCache
  core/
    ids.ts        sanitizeId / safeAssign / hasUnsafeKeyDeep（proto 防线）
    model.ts      ConnectorRecord + normalize（args bug 守卫）+ publicView/redactTarget
    store.ts      RegistryStore：原子写+回读+快照+generation+fail-closed
  client/
    index.ts      web 客户端半区：设置卡片 + 连接器管理（CJS ModuleLoader 包裹，走宿主网关）
    jsonrpc.ts / transport-error.ts（失败分类码）/ http-client.ts / stdio-client.ts（Windows shim 移植自 openhanako）
  io/
    import.ts     mcpServers JSON 导入（fail-loud）
    export.ts     导出（默认脱敏）
  surface/
    tool.ts       三个 agent 工具（defineTool `as any` 断言——TS2321 先例）
    command.ts    /mcp-reg 全部子命令
    http.ts       /mcp-registry/api 网关（POST-only、same-origin、脱敏投影）
tests/            67 用例（authz 表驱动 / store / model / import / stdio-cmdline / http / bridge）
```

依赖方向：surface → bridge → authz+store+client；authz 是纯函数，无 IO。

## 3. 怎么改

- **加连接器字段**：`core/model.ts` 的 `ConnectorRecord` + `normalizeConnectorInput`（白名单字段+长度上限）→ `io/export.ts` 导出形状 → 测试。
- **改授权规则**：**只改 `src/authz.ts`**。任何路径不得复述规则（drift 即旁路）。改完跑 authz 表驱动测试。
- **加 /mcp-reg 子命令**：`surface/command.ts` 的 `dispatch`。写操作必须走 store 的字段级 mutator。
- **加传输**：实现 SessionLike（request/initialize/close）→ `bridge.ts` defaultSessionFactory 分发。

## 4. 坑位清单（每条都是本仓库或参考实现的血泪）

1. **args 永远是数组**。导入 `"args": "-y srv"`（字符串）必须带 id 报错——openhanako 静默丢弃这个形状导致服务器起不来且无因（`mcp-config.ts arrayOfStrings`）。`command` 含空格且无 args 同理拒绝，绝不自动拆分（粘参数 bug 的根源）。
2. **授权规则只活在 authz.ts**。新表面（新命令/新工具）必须路由 `resolveToolAccess`，禁止第二份实现。
3. **活证据仅内存**。readOnlyHint/destructiveHint 的服务器声明进 `bridge.evidence`（Map），重启即空 → fail-closed review。持久化它 = 让手改文件变成信任输入。
4. **destructiveHint 是硬否决**，压过显式 allow（已知危险 > 授权）——在判定缝里实现，不要在调用点特判。
5. **store 写入 = 快照 → tmp → rename → 读回校验**。Windows rename 覆盖已存在文件可能失败，有 rm+rename 兜底。跳过读回 = 半写不可见。
6. **损坏 fail-closed**：解析失败/未来版本 → 全部端点视为不存在 + `.corrupt-<ts>` 保留 + 拒绝写入。**绝不**自动重建——"善意恢复"会静默改写用户授权。
7. **defineTool 选项必须 `as DefineToolOpts`（any）断言**，否则 schemastery 递归泛型炸 TS2321（dsh-browser-cdp 同款先例）。
8. **JS 字面量 `{ __proto__: 'x' }` 不是 own key**（是设原型）——测试 proto 防线必须用 `JSON.parse` 构造。运行时写动态键一律 `safeAssign`。
9. **stdio spawn 数组传参 + shell:false**；Windows `.cmd/.bat` shim 走 `cmd.exe /d /s /c` 且逐参 `quoteWin32CmdArg`（% 翻倍、引号转义）——拼命令行字符串只允许发生在 `buildWin32CmdLine` 一处。
10. **错误消息只带 id + host:port/分类码**，绝不透传底层异常（fetch 异常内嵌完整 URL=凭据泄漏）。
11. **http 非 loopback 拒绝**（https 不限）——dsh-mcp-connector 的安全默认。
12. **0.2.0 宿主两条新契约**（真机踩出来的）：① 插件管理器**强制校验 peerDependencies**，peer 放行区间必须显式写 prerelease 分支（`|| >=0.2.0-rc.1 <0.3.0-0`）——npm semver 的 tuple 规则下 `<0.3.0-0` 这种宽区间**不匹配** 0.2.0-rc.x；② cordis 对**未注入的服务属性访问直接抛错**（`cannot get property "commands" without inject`），任何 `ctx.xxx` 守卫写法在属性访问一步就会炸——服务必须在 `inject` 数组声明，方法级 feature-detect 只负责兜底。`ctx.get('webServer')` 是例外（可选服务访问器，无需 inject）。
13. **0.2.0 宿主 webServer 晚启动**：`webServer` 由 `dsh-host-webserver` 插件提供，启动晚于我们的 apply——apply 时和 effect 时 `ctx.get('webServer')` 都是 undefined（文件探针实证，effect 只跑一次救不了）。**必须用 cordis 动态 inject** `['webServer']`（thinking-levels modelDirectories 模式）：服务就绪时回调才触发；无 web 服务的宿主 inject 永不触发、安全降级。
14. **client 设置卡的铁律**：① `configForms` 必须声明进 client `inject`（0.2.3 教训：apply 时同步 get 拿到 undefined，整个卡片静默没注册）；② `dsh.client.inject` 必须列出服务提供模块（`dsh-client-ui-slots`→slots、`dsh-client-ui-settings`→configForms）；③ `settings.section` 的 inject face（`hooks.tabs`）被设置壳转化为 **`useTabs` 选择器 hook**，renderSlot 是可选派发器——按 props.useTabs / props.renderSlot 消费。
15. **家族设置挂靠惯例**（session-steward 范本，用户明确要求）：常驻 `dsh-family.tab` 贡献卡（thinking-levels 在场时是「起子插件设置」里的 tab）；**家族节接管选举**——宽限期后无 `dsh-family` 节则同 id 接管并通用渲染全部贡献卡，且要**再武装**（订阅 settings.section 变更 + 兜底轮询）：宿主被卸载时家族面原地保留、名字保持「起子插件设置」；接管节组件必须带 tablist 层级（pill 样式照抄 family-tab.tsx），不能平铺。
13. **验证工具链**：临时宿主冒烟 = `_tmp-dsh020/`（`npm i @deepseek-ai/dsh@0.2.0-rc.2`）+ `DSH_HOME=<tmp> dsh rescue --from-default-profile web` → `dsh plugin --profile rescue add -w <tgz>`（-w 必须，pnpm workspace-root）→ `dsh --profile rescue --dump-config`（组合校验）→ `timeout 25 dsh --profile rescue`（真实挂载，grep 启动日志；加 `--no-open` 防弹浏览器）。

## 5. 回退 / 卸载

- 从 profile 移除 patch 行（`cordis.patch.yml` 的 insert 项）即可卸载；`~/.dsh/mcp-registry/` 数据目录可整体删除或留存。
- 插件缺失/禁用时无任何残留行为（无全局 patch、无宿主改动）。

## 6. 已知边界（诚实不粉饰）

- **review 判定 = 诚实拒绝**：DSH 0.1.7 无每调用审批链，review-all 下的 agent 调用返回 needs_review 文本（含 grant 指引），不执行、不伪装"已请示"。
- **/mcp-reg probe|call 返回 Promise**：宿主若不 await 命令 handler，这两个子命令无回显（list 等同步子命令不受影响）。
- **探活仅手动**（/mcp-reg probe / bridge 内部懒初始化）；无后台循环、无 SSE 推送。
- **v1 无 OAuth / SSE 旧传输 / 无物理删除**（只 disable）；`listAuthorized` 只返回 allowlist 且已启用的连接器。
- **stdio 会话常驻**：首次调用 spawn 后复用，closeAll 挂在 ctx.effect；连接器被 disable 不会杀掉已 spawn 的子进程（下次 enable 复用同一会话）——如需强杀，重启插件。
