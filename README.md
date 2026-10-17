# dsh-mcp-registry

DSH 插件：**MCP 连接器受治理注册表**。借鉴 [dsh-mcp-connector](https://github.com/duhu2000/dsh-mcp-connector)、[dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) 的职责边界设计，吸收 openhanako `core/mcp` 的授权模型与已知 bug 教训。

## 它做什么

- **注册表**：登记 stdio / streamable-http MCP 连接器，持久化在 `~/.dsh/mcp-registry/registry.json`（原子写 + 写后回读 + 滚动快照 ≤20）。
- **四级 fail-closed 授权**：全局开关 → 连接器 `permissionMode`（缺省 review-all）→ 工具级 grant → 服务器活声明证据（仅内存，重启即失效）。`destructiveHint` 是硬否决：已知危险压过任何授权。
- **诚实桥接**：agent 用 `mcp_bridge_call` 调 MCP 工具；review 判定返回结构化 `needs_review`（含 grant 指引），**不执行、不伪装**。
- **fail-loud 导入**：`mcpServers` JSON 里 `args` 是字符串、`command` 带空格无 args、`__proto__` 键 → 一律带 id 报错拒绝（openhanako 静默丢 args bug 的反向验收）；导入落地默认 disabled + 待人工确认。
- **全边界脱敏**：agent 只读工具/命令/导出/HTTP 状态一律投影（origin / 命令基名），token 与 env 明文值不出注册表。
- **原生工具懒加载（可选）**：`lazyNativeTools` 开启后，在 `system-prompt/assemble` 瀑布层把非核心原生工具（shell/文件/搜索等）的完整 schema 折叠出常驻 prompt，只留 `tool_discover`（紧凑目录）+ `tool_activate`（按需展开）两个常量元工具——让**无法做 mid-conversation 工具变更的第三方 LM 连接器**也吃到近恒定的工具 token。工具仍在 `ctx.tools`（执行/TUI/restrict 不受影响），变的只是 prompt 载荷；MCP 工具（`mcp__*`）不由它折叠（走 bridge）。激活按 agent 作用域隔离、纯内存、重启回冷。缺省关；`lazyKeepAlways` 缺省为空（开启即隐藏全部非注册表原生工具，可按需列入核心集）。另会注入一段发现引导 system prompt（常驻告知 MCP bridge 链路，懒加载开启时追加 `tool_discover`/`tool_activate`）——因为 MCP 工具从不逐个声明，没这段叙述模型无从得知有 MCP 可试。
- **懒加载两档（`lazyEagerIndex`，缺省 true）**：仅影响原生工具的披露形态。开（Mode B，skill-catalog 式）：引导段直接摊开隐藏原生工具的 `名字 (一行摘要)` 名单，模型免 `tool_discover` 直接 `tool_activate`，常驻成本 O(n·一行)；关（Mode A）：名单不预摊，模型先 `tool_discover` 再 `tool_activate`，常驻 O(1)。两档工具 schema 都仍被折叠隐藏，**都要 `tool_activate` 才变成可调用**。名单数据源每次组装从 `ctx.tools.schemas(agent)` 实读（无首轮空窗），宿主无 `schemas` 时降级回退折叠缓存。

## 快速上手

```
mcp-reg import D:\configs\mcp.json     # 导入（全部 disabled + UNCONFIRMED）
mcp-reg list                           # 查看注册表
mcp-reg probe <id>                     # 一次 MCP initialize 握手
mcp-reg confirm <id>                   # 确认并启用
mcp-reg mode <id> allowlist            # 允许策略化放行
mcp-reg grant <id> <tool>              # 显式放行某工具（agent 可调）
mcp-reg call <id> <tool> '{"k":"v"}'   # 人工调用（即视同批准）
```

agent 侧：`mcp_registry_status` → `mcp_bridge_list_tools` → `mcp_bridge_call`。

懒加载（开启 `lazyNativeTools` 后）：agent 侧 `tool_discover` 查看被折叠的非核心原生工具 → `tool_activate` 按名展开，下一轮该工具以完整 schema 回到 prompt。缺省 `lazyKeepAlways` 为空，连 bash/read 也需先 discover+activate；想免这一回合就在配置里列入核心工具名。模型由一段常驻的发现引导 system prompt 告知“MCP 走 bridge、隐藏原生工具走 discover/activate”。

## 工程

```
npm run typecheck   # strict TS，0 错误
npm run test        # vitest，81 用例
npm run build       # tsdown → lib/index.js（dsh-tools external）
```

- 目标宿主：DSH 0.2.0 线与 0.2.1-rc.1（`latest` = 0.3.6）；DSH 0.1.7 线用 `dsh-mcp-registry@dsh-0.1.7`（= 0.3.3）。
  **0.1.6 及以下不再支持也不再测**（作者决定，2026-10-13）：`latest` 自 0.2.x 时代的最宽范围
  `>=0.1.0-0 <0.3.0-0` 收窄为精确枚举 `0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1`（逐 rc 单列，禁区间/caret；0.1.6 及以下、0.3.x 未来版均被拒），老线安装会被
  宿主按 `engines.dsh` 拒装——这是有意的，不是回归。历史 tag（`dsh-0.1.1` / `dsh-0.1.2` /
  `dsh-0.1.5`）仍指旧版，仅供取用，不再验证。
- 安装：profile patch 加一行 `- insert: [{id: dsh-mcp-registry, name: "dsh-mcp-registry"}]`（或直接用本仓库 `cordis.patch.yml`）。
- 插件 inject `['tools','commands']`：宿主提供 commands 服务即全功能（web/tui/headless 模板均提供）；`webServer` 缺席只影响状态路由，tools 不受影响。

## 版本 ↔ DSH 宿主线

版本号按 DSH 宿主发布线预留进度；**`latest` = 0.3.6**：

| npm 版本 | dist-tag | 目标 DSH 宿主 | 状态 |
|---|---|---|---|
| 0.1.1 / 0.1.2 / 0.1.5 | `dsh-0.1.1` 等 | 0.1.1 ~ 0.1.6 各线 | 预留占位（deprecated，不测） |
| 0.1.7 | — | `>=0.1.7-rc.1 <0.1.8-0` | 旧宿主线（peer 仅容 dsh-tools 0.1.7） |
| 0.2.0 | — | `>=0.2.0-0` | 已弃用：peer 未放行 dsh-tools 0.2.x，被 0.2.0 宿主拒装 |
| 0.2.1 | — | `>=0.2.0-0` | 已弃用：未声明 commands inject，0.2.0 宿主挂载报错 |
| 0.2.2 | — | `>=0.2.0-0` | 曾为 latest；已由 0.3.x 接替 |
| 0.3.3 | `dsh-0.1.7` | `>=0.1.7-rc.1 <0.1.8-0 \|\| >=0.2.0-rc.1 <0.3.0-0` | 0.1.7 线定版 |
| 0.3.4 / 0.3.5 | `dsh-0.2.0`（= `latest`） | 同上 | 0.2.0 线（MCP 注册表面与连接器管理修复） |
| **0.3.6** | `dsh-0.2.0`（= `latest`） | `0.1.7-rc.1 \|\| 0.1.7-rc.2 \|\| 0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1`（TRIM5 精确枚举） | **当前主推线**（补齐 0.2.1-rc.1 适配，五写点同串收窄） |

## 设计边界（与 dsh-mcp-connector 同一条线）

本插件只管**目录、治理、健康、诊断**；MCP 会话与工具执行由内置的薄客户端按需完成，不做常驻 bridge、不做每工具模型工具注册。授权规则只活在 `src/authz.ts` 一个文件里——所有表面路由同一个判定缝。

详见 [HANDOVER.md](./HANDOVER.md)（结构、坑位清单、已知边界）与 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
