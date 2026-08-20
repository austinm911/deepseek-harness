# Agent Note: Claude subscription authentication paths

Status: implemented

[English](2026-08-19-claude-subscription-auth-paths.md) | 中文

## Problem

Claude Pro/Max 订阅不是 API 密钥，而订阅有可能进入本 harness 的两个位置，各自因不同原因拒收它。

`claude-code` 引擎路由通过官方 Agent SDK 启动 Claude Code CLI（命令行界面），因此由 CLI 自行完成认证。如果宿主上唯一的 Claude 凭据是 `claude setup-token` 签发的 `sk-ant-oat01…` OAuth token——既没有 `~/.claude/.credentials.json`，也没有 macOS 的 `Claude Code-credentials` 钥匙串项——子进程就看不到它：`scrubbedParentEnv()`（`packages/subprocess/subprocess/src/index.ts`）会从每个 harness 子进程的环境变量中删除所有匹配 `SENSITIVE_ENV_PATTERN`（`/KEY|PASSWORD|SECRET|TOKEN/i`）的名称，`CLAUDE_CODE_OAUTH_TOKEN` 也在其中，于是 CLI 报告 `Not logged in`。该引擎运行随后以 `ENGINE_FAILURE` 结束会话。

harness 自身的 agent loop（智能体循环）则完全没有由订阅支撑的 Claude 路由。`dsh-llm-pi-ai` 上的 `anthropic` 路由解析 `ANTHROPIC_API_KEY` 并将其作为计费 API 密钥发送；把订阅 token 填进该字段，并不是 Anthropic Messages 端点对 API 密钥客户端所接受的形式。

## Decision

Claude 订阅通过两条并存的路径进入本 harness。引擎路径是默认路径，也是受官方认可的路径；API 路径为可选启用。

**引擎路径：凭据归 CLI 所有，只显式转发一个名称。** `packages/subagent/subagent-claude-code` 将 Agent SDK 子进程的环境构造为 `{ ...scrubbedParentEnv(), ...config.env }`，因此该条目显式的 `env` 层是凭据形态名称到达该子进程的唯一途径。`dsh-multi-provider` 的 patch 恰好转发一个名称 `CLAUDE_CODE_OAUTH_TOKEN`，使用的 `!!js` 表达式在该变量未设置时返回 `{}`。因此，凭据保存在 CLI 自有凭据存储中的宿主，其组合与运行都不受影响：未设置的变量不贡献任何条目，子进程按 CLI 独立运行时的方式解析凭据。`SENSITIVE_ENV_PATTERN` 与 `scrubbedParentEnv()` 保持不变，所以对其他所有子进程而言，环境隐式转发依然关闭；也不识别任何 harness 专用的 token 变量别名：`CLAUDE_CODE_OAUTH_TOKEN` 就是 CLI 自己读取的名称，拼错会显式失败而不会被解析。

**API 路径：一个 `anthropic-subscription` pi-ai 路由，本仓库不拥有传输层代码。** `@earendil-works/pi-ai@0.82.1` 的 Anthropic Messages 传输层用 `isOAuthToken(apiKey) => apiKey.includes('sk-ant-oat')` 检测已解析的凭据。命中时，它将该值作为 `authToken` 发送（Bearer，`apiKey: null`），加上 `anthropic-beta: claude-code-20250219,oauth-2025-04-20`、`user-agent: claude-cli/<version>` 和 `x-app: cli`，在前面插入一个 `You are Claude Code, Anthropic's official CLI for Claude.` 系统提示词块，并对工具名称做归一化。把订阅 token 交给该传输层就是全部实现，因此这条路由只是配置：`api: anthropic-messages`、`baseURL: https://api.anthropic.com`、`apiKeyEnv: ANTHROPIC_OAUTH_TOKEN`、`displayName: Claude (Pro/Max subscription)`，模型为 `claude-opus-5`、`claude-sonnet-4-5`、`claude-haiku-4-5`。基于密钥的 `anthropic` 路由（`ANTHROPIC_API_KEY`）保持原样；两者是同一适配器上的独立路由，因此同一部署可同时服务两种凭据形态，会话通过模型选择在两者之间挑选。

**两条路径都只写凭据引用。** 每条路径各指定一个环境变量——转发到子进程 `env` 的 `CLAUDE_CODE_OAUTH_TOKEN`，以及 `apiKeyEnv` 中的 `ANTHROPIC_OAUTH_TOKEN`——任何配置、文档、测试或 fixture（测试前置数据）都不携带 token 的实际值。API 路由的凭据像其他 pi-ai 路由一样按请求经凭据 seam 解析，因此轮换后的 token 会在紧接着的下一次请求中生效。两条配置行都位于由[多提供方组合包 Agent Note](2026-08-14-multi-provider-pack-and-engines.md) 拥有的 `dsh-multi-provider` patch 中。

## Verification

引擎路径由 CLI 自身行为固定：在只有 token 的宿主上，`claude -p` 报告 `Not logged in`；设置 `CLAUDE_CODE_OAUTH_TOKEN` 后，同一调用正常作答。API 路径针对线上端点固定：使用该传输层的 OAuth 请求头和一个订阅 token 调用 `POST https://api.anthropic.com/v1/messages`，对该路由公布的每个模型都返回 HTTP 200。

## Alternatives considered

**读取 Claude Code 自有的凭据存储。** 已否决。`~/.claude/.credentials.json` 与 macOS 的 `Claude Code-credentials` 钥匙串项保存的是短期访问 token 加刷新 token，其所有者是 harness 无法控制的进程。消费它们意味着自行实现刷新并把结果写回一个外部存储、在两者同时运行时与 CLI 自身的轮换竞态、在 macOS 上触发钥匙串 ACL 提示，还要跟踪上游可能在任何版本更改的未公开磁盘格式。`claude setup-token` 的值完全不需要这些：它长期有效、由用户签发，并且只由一个环境变量承载。

**放宽子进程环境清理。** 已否决。收窄 `SENSITIVE_ENV_PATTERN` 或为该 token 名称开例外，会把它隐式转发给每一个 harness 子进程——bash、终端、语言服务器、每个委派后端——只为服务唯一需要它的那个子进程。按条目显式的 `env` 层已经在清理之后合并，恰好把这一个名称送到恰好那一个子进程。

**自行拥有一个 Anthropic OAuth 传输层。** 依据[优先使用依赖而非自行实现的策略](../process/2026-07-26-dependencies-over-hand-rolling.md)否决：已安装的 pi-ai 版本已经实现了 OAuth token 检测、切换到 Bearer、Claude Code 身份请求头，以及端点要求的工具名称归一化，手写副本还要承担这些内容的漂移。

**把 API 路径设为默认，或设为唯一路径。** 依据下文的长期风险否决。对订阅而言，CLI 引擎路由是 Anthropic 认可的路径，因此它保持默认；API 路由是部署方主动添加的可选路由。

## Consequences

API 路径用 Claude Pro/Max token 为一个并非 Claude Code 的客户端完成认证，同时 pi-ai 呈现 Claude Code 的身份请求头，这在 Anthropic 服务条款上处于灰色地带。这一说明随该路由出现在其被记录的任何位置，而 CLI 引擎路由仍是受认可的默认路径。不接受该风险的部署组合引擎路由并让 `ANTHROPIC_OAUTH_TOKEN` 保持未设置；此时该路由以 `MISSING_CREDENTIAL` 显式失败并指出该变量，而不是降级运行。

引擎路径的代价是在已发布的 patch 中多一个显式 `env` 条目，同时对其他一切保持子进程环境清理的绝对性。它的取舍在于转发是按条目生效的：另一个从自己的条目启动 Claude Code 的组合需要自行转发该名称，而在没有该条目的 profile 中，引擎路由只能依据 CLI 的凭据存储完成认证。

API 路径为由订阅支撑的 Claude 模型带来 harness 的循环、工具、会话日志和审批 seam，这是引擎路径给不了的——引擎轮次运行 CLI 自己的循环，且只记录文本。它的代价是需要解释第二种 Claude 凭据形态，且两条路由以不同名称公布重叠的模型 id。
