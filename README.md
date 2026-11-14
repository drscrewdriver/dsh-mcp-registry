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

## 局域网明文 HTTP（plainHttpAllowlist）

连接器 URL 的默认规则是 **https 任意主机放行、明文 http 仅限回环**（`localhost` / `127.x` / `::1`）。这条限制
本意是防止 MCP 连接器的 `authToken` / `headers` 走明文链路被同网段嗅探——它照抄了 dsh-mcp-connector 的默认，
作为默认值合理，作为硬墙过头：一台不对外提供服务的局域网个人机器不该为此去维护域名和证书。

新增 volatile 设置 **`plainHttpAllowlist`**（缺省 `[]` = 完全维持上述旧行为）把「拒绝」变成「按需授予」：

- **三种写法**：精确主机（`192.168.1.23` / `nas.lan`，大小写与根尾点不敏感）、IPv4 CIDR（`192.168.1.0/24`，
  前缀不得宽于 `/8`）、单标签通配（`*.lan` 放行 `nas.lan`，但不放行裸 `lan` 或 `evillian`）。
- **硬地板不可覆盖**：链路本地 `169.254.0.0/16`（含云元数据地址 `169.254.169.254`）与 `0.0.0.0` **任何白名单条目都放行不了**，
  落代码层。非法条目（越界八位组、`/33`、`*.`、宽于 `/8` 的段）带原因报错，绝不静默丢弃。
- **两处执行点**：写入时（`mcp-reg add`/import 早报错，文案点名要授予的主机）**且**运行期建会话时（`bridge.ts`）强制。
- **为何两出执行点**：`store.load()` 从 `registry.json` 直接取连接器数组不重新校验，所以**手写/改过的注册表文件会绕过
  写入校验**——真边界在运行期：一条未授予的非回环明文 http 记录在 probe/list/call 时会被 `http-plain-not-allowed` 拒绝，
  且**不发出任何网络请求**。因此“改了 registry.json 就能绕过”不成立。
- **可见性**：命中放行的非回环明文连接器在列表行显示琥珀徽标「明文 HTTP（白名单放行）」；回环/https/stdio 不显示。
  收紧白名单不会主动断开**已建立**的会话（下次建会话才生效）；需立即切断则重启插件。

> 本闸门只约束本仓自己的桥接路径。若装机侧改用手动的官方 `dsh-mcp-connector` 作后端，那条链路的明文限制由其自身策略决定，不在本仓管辖内。

## 工程

```
npm run typecheck   # strict TS，0 错误
npm run test        # vitest，146 用例
npm run build       # tsdown → lib/index.js（dsh-tools external）
```

- 目标宿主：DSH 0.2.0 线与 0.2.1-rc.1/rc.2/rc.3（`latest` = 0.3.7）；DSH 0.1.7 线用 `dsh-mcp-registry@dsh-0.1.7`（= 0.3.3）。
  **0.1.6 及以下不再支持也不再测**（作者决定，2026-10-13）：`engines.dsh`（顶层与 `dsh.engines.dsh` 两处）
  声明为有界区间 `>=0.1.7-rc.1 <0.3.0`（下限 = 0.1.7-rc.1，上限不含 0.3 线；0.1.6 及以下被拒），
  `peerDependencies` 仍逐 rc 枚举（npm 解析不默认带 `includePrerelease`），两者形状不同是故意的；
  老线安装会被宿主按 `engines.dsh` 拒装——这是有意的，不是回归。历史 tag（`dsh-0.1.1` / `dsh-0.1.2` /
  `dsh-0.1.5`）仍指旧版，仅供取用，不再验证。
- 安装：profile patch 加一行 `- insert: [{id: dsh-mcp-registry, name: "dsh-mcp-registry"}]`（或直接用本仓库 `cordis.patch.yml`）。
- 插件 inject `['tools','commands']`：宿主提供 commands 服务即全功能（web/tui/headless 模板均提供）；`webServer` 缺席只影响状态路由，tools 不受影响。

## 版本 ↔ DSH 宿主线

版本号按 DSH 宿主发布线预留进度；**`latest` = 0.3.7**：

| npm 版本 | dist-tag | 目标 DSH 宿主 | 状态 |
|---|---|---|---|
| 0.1.1 / 0.1.2 / 0.1.5 | `dsh-0.1.1` 等 | 0.1.1 ~ 0.1.6 各线 | 预留占位（deprecated，不测） |
| 0.1.7 | — | `>=0.1.7-rc.1 <0.1.8-0` | 旧宿主线（peer 仅容 dsh-tools 0.1.7） |
| 0.2.0 | — | `>=0.2.0-0` | 已弃用：peer 未放行 dsh-tools 0.2.x，被 0.2.0 宿主拒装 |
| 0.2.1 | — | `>=0.2.0-0` | 已弃用：未声明 commands inject，0.2.0 宿主挂载报错 |
| 0.2.2 | — | `>=0.2.0-0` | 曾为 latest；已由 0.3.x 接替 |
| 0.3.3 | `dsh-0.1.7` | `>=0.1.7-rc.1 <0.1.8-0 \|\| >=0.2.0-rc.1 <0.3.0-0` | 0.1.7 线定版 |
| 0.3.4 / 0.3.5 | `dsh-0.2.0`（= `latest`） | 同上 | 0.2.0 线（MCP 注册表面与连接器管理修复） |
| **0.3.6** | `dsh-0.2.0`（= `latest`） | `0.1.7-rc.1 \|\| 0.1.7-rc.2 \|\| 0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1`（TRIM5 精确枚举） | 0.2.1-rc.1 适配线（五写点同串收窄） |
| **0.3.7** | `latest` + `dsh-0.2.1-rc.2` | `0.1.7-rc.1 \|\| 0.1.7-rc.2 \|\| 0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-rc.2`（TRIM6 精确枚举） | **当前主推线**（补票 0.2.1-rc.2，五写点同串） |

## 设计边界（与 dsh-mcp-connector 同一条线）

本插件只管**目录、治理、健康、诊断**；MCP 会话与工具执行由内置的薄客户端按需完成，不做常驻 bridge、不做每工具模型工具注册。授权规则只活在 `src/authz.ts` 一个文件里——所有表面路由同一个判定缝。

详见 [HANDOVER.md](./HANDOVER.md)（结构、坑位清单、已知边界）与 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
