# dsh-mcp-registry

DSH 插件：**MCP 连接器受治理注册表**。借鉴 [dsh-mcp-connector](https://github.com/duhu2000/dsh-mcp-connector)、[dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) 的职责边界设计，吸收 openhanako `core/mcp` 的授权模型与已知 bug 教训。

## 它做什么

- **注册表**：登记 stdio / streamable-http MCP 连接器，持久化在 `~/.dsh/mcp-registry/registry.json`（原子写 + 写后回读 + 滚动快照 ≤20）。
- **四级 fail-closed 授权**：全局开关 → 连接器 `permissionMode`（缺省 review-all）→ 工具级 grant → 服务器活声明证据（仅内存，重启即失效）。`destructiveHint` 是硬否决：已知危险压过任何授权。
- **诚实桥接**：agent 用 `mcp_bridge_call` 调 MCP 工具；review 判定返回结构化 `needs_review`（含 grant 指引），**不执行、不伪装**。
- **fail-loud 导入**：`mcpServers` JSON 里 `args` 是字符串、`command` 带空格无 args、`__proto__` 键 → 一律带 id 报错拒绝（openhanako 静默丢 args bug 的反向验收）；导入落地默认 disabled + 待人工确认。
- **全边界脱敏**：agent 只读工具/命令/导出/HTTP 状态一律投影（origin / 命令基名），token 与 env 明文值不出注册表。

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

## 工程

```
npm run typecheck   # strict TS，0 错误
npm run test        # vitest，67 用例
npm run build       # tsdown → lib/index.js（dsh-tools external）
```

- 目标宿主：DSH 0.2.0 线（latest = 0.2.2）；DSH 0.1.7 线用 `dsh-mcp-registry@dsh-0.1.7`。
- 安装：profile patch 加一行 `- insert: [{id: dsh-mcp-registry, name: "dsh-mcp-registry"}]`（或直接用本仓库 `cordis.patch.yml`）。
- 插件 inject `['tools','commands']`：宿主提供 commands 服务即全功能（web/tui/headless 模板均提供）；`webServer` 缺席只影响状态路由，tools 不受影响。

## 版本 ↔ DSH 宿主线

版本号按 DSH 宿主发布线预留进度；**`latest` = 0.2.2（当前主推线，已在 DSH 0.2.0-rc.2 宿主上真机启动验证）**：

| npm 版本 | dist-tag | 目标 DSH 宿主 | 状态 |
|---|---|---|---|
| 0.1.1 / 0.1.2 / 0.1.5 | `dsh-0.1.1` 等 | 0.1.1 ~ 0.1.6 各线 | 预留占位（deprecated） |
| 0.1.7 | `dsh-0.1.7` | `>=0.1.7-rc.1 <0.1.8-0` | 旧宿主线（peer 仅容 dsh-tools 0.1.7） |
| 0.2.0 | — | `>=0.2.0-0` | 已弃用：peer 未放行 dsh-tools 0.2.x，被 0.2.0 宿主拒装 |
| 0.2.1 | — | `>=0.2.0-0` | 已弃用：未声明 commands inject，0.2.0 宿主挂载报错 |
| **0.2.2** | `dsh-0.2.0`（= `latest`） | `>=0.2.0-0` | **当前主推线**（peer 兼容 dsh-tools 0.1.7+0.2.x，inject 含 commands） |

## 设计边界（与 dsh-mcp-connector 同一条线）

本插件只管**目录、治理、健康、诊断**；MCP 会话与工具执行由内置的薄客户端按需完成，不做常驻 bridge、不做每工具模型工具注册。授权规则只活在 `src/authz.ts` 一个文件里——所有表面路由同一个判定缝。

详见 [HANDOVER.md](./HANDOVER.md)（结构、坑位清单、已知边界）与 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
