# @deepseek-ai/dsh-llm-engine

[English](README.md) | 中文

面向本地引擎 CLI 的对话模型路由。该插件在 `ctx.llm` 上注册 `codex` 与 `claude-code` 两条提供方路由。在 Models 选择器、`agent-default-model` 或任何模型选择中选中其一后，每一轮都会经由打包的 Codex app-server 或 Claude Agent SDK 运行，并以 CLI 自身的登录态认证（Codex 用 ChatGPT，Claude Code 用 claude.ai）。全程不涉及 API key。

## 安装

本包是一个 Profile Bundle。其 `cordis.patch.yml` 会插入 `llm-engine` 行，因此装入 profile 即可：

```sh
pnpm pack                                    # 在本目录执行
dsh plugin --profile <name> add /path/to/deepseek-ai-dsh-llm-engine-<version>.tgz
```

desktop profile 由应用管理。请通过 **Settings → Plugins → Install** 填入 tarball 路径安装，或在应用关闭时把 tarball 加入 `~/.dsh/profiles/desktop`。

`lib/index.js` 内联了本仓库的 `dsh-subagent-codex` 与 `dsh-subagent-claude-code` 运行入口。其余 `@deepseek-ai/*` 导入均为 Harness 安装已自带的 peer。`@openai/codex` 与 `@anthropic-ai/claude-agent-sdk` 是普通依赖，因此 profile 自带其 CLI 版本。

## 行为

- **提示。** 引擎只接收最新一条直接用户消息。上下文注入（AGENTS.md、skill 目录、工具结果）会被跳过。Harness 的系统提示、历史和工具从不发送。引擎在自己的进程中运行自己的工具，作用范围为会话的工作目录。
- **续接。** `continuation` 开启（默认）时，每个 Harness 会话各保留一个原生 Codex thread 与一个 Claude 会话。它们的 id 存于 `llm_engine_sessions` 存储域，因此重启后重新打开的会话会续接同一段引擎对话。续接失败会使该轮失败，绝不会悄悄另起新对话。
- **流式输出。** 实时回答文本以增量形式流出。block-end 中的文本是引擎的最终回答。
- **模型。** 每条路由在插件生命周期内向其打包的 CLI 查询一次目录：Codex 通过 app-server 的 `model/list`，Claude 通过 Agent SDK 的 `supportedModels()`。模型列在 `native`（CLI 配置的默认模型）之后。查询失败时只提供 `native`，并记录原因。目录中未列出的模型 id 仍可解析，因此已保存的会话照常可用，由 CLI 判断是否提供该模型。
- **推理强度。** Harness 的 `off` 对应 Codex 的 `minimal` 与 Claude 的关闭思考，其余强度原样传递。
- **拒绝。** 压缩与会话标题调用以 `UNSUPPORTED_PURPOSE` 结束。没有会话工作目录的轮次以 `NO_WORKSPACE` 结束。引擎失败以 `ENGINE_FAILURE` 结束，并附带引擎的诊断信息（例如登录过期）。引擎轮次从不重试。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `continuation` | `true` | 每个 Harness 会话与路由续接一个原生引擎会话 |
| `modelDiscovery` | `true` | 向每条路由的 CLI 查询目录 |
| `discoveryTimeoutMs` | `10000` | 单次查询（含握手）的截止时间 |
| `codexContextWindow` | `272000` | 为每个 `codex` 模型假定的上下文窗口，供压缩使用 |
| `claudeContextWindow` | `1000000` | 为每个 `claude-code` 模型假定的上下文窗口，供压缩使用 |
| `codexPermissionMode` | `approve-for-me` | Codex 模式：`never`、`approve-for-me`（workspace-write 沙箱，自动审阅）或 `dangerously-bypass-approvals-and-sandbox` |
| `claudePermissionMode` | `acceptEdits` | Claude Code 模式：`dontAsk`、`acceptEdits`、`auto`、`plan` 或 `bypassPermissions` |
| `claudeEnv` | `{}` | 转发给 Claude 子进程的环境变量；设置了 `CLAUDE_CODE_OAUTH_TOKEN` 时 bundle 会转发它 |
| `disposeGraceMs` | `3000` | 进程树各终止层级之间的宽限时间 |

## 已知限制

- **旧版 Codex CLI 会被拒绝。** ChatGPT 登录会拒绝在旧版 Codex CLI 上使用当前模型（"model is not supported when using Codex with a ChatGPT account"）。出现时请升级 `@openai/codex` 依赖。
- **容量靠配置而非上报。** 两个目录都不含上下文窗口，因此 `codexContextWindow` 与 `claudeContextWindow` 分别适用于各自路由上的所有模型。
- **已存储的原生 id 不会清理。** 每个会话的记录只有几个字节，且没有会话删除事件可用于清理。
