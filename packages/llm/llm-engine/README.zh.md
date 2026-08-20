# @deepseek-ai/dsh-llm-engine

[English](README.md) | 中文

面向本地引擎 CLI 的 LLM seam 适配器。在 `ctx.llm` 上注册 `claude-code` 与 `codex` 两条 provider 路由，由对应的 [`ctx.subagents`](../../subagent/subagent/README.md) 后端支撑：[`dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.md) 运行官方 Claude Agent SDK，[`dsh-subagent-codex`](../../subagent/subagent-codex/README.md) 运行官方 `codex app-server`。把会话的 provider 选成这两条路由之一——无论是在 web Models 选择器、`agent-default-model` 还是任意模型选择里——每一次回合都会通过本地 CLI 运行，使用其**原生 OAuth 状态（claude.ai／ChatGPT 登录）；完全不需要任何 API 密钥**。

## 这个适配器做什么

`stream()` 取最新一条**直接**用户提示词的文本（AGENTS.md、技能目录这类合成上下文注入按 source kind 排除），通过 `ctx.subagents` 启动对应的后端（带一个只含 cwd 的桩父级），在运行期间把引擎的**实时文本增量**作为 `text-delta` 块转发，最后用组装好的最终回答加一个终止 finish 收尾。引擎是 agent 而不是模型端点：它们在各自进程内执行自己的工具，因此 harness loop 看到的是纯文本回合，会话日志像记录其他助手消息一样记录回答。引擎运行**绝不重试**（`maxRetries: 0`）：重试等于把 CLI 执行两遍。

**长会话。** 开启 `continuation: true`（插件配置加上对应的后端行）后，适配器按 harness 会话 id 为引擎会话建索引，并在后续每一回合恢复它：Claude Code 走 SDK 的 `resume`（`persistSession`），Codex 在持久线程上走 `thread/resume`。于是引擎能记住同一个 harness 会话的早期回合——一段连续对话，而不是每次重新开始。

拒绝面（全部是 error finish，不启动任何引擎进程）：

- **没有用户文本**——`EMPTY_PROMPT`：引擎需要一个非空指令。
- **辅助用途**——`UNSUPPORTED_PURPOSE`：压缩与会话标题调用会为一件边角任务启动一次完整 agent 运行。
- **非 completed 结果**——`ENGINE_FAILURE`（显式取消则为 `ABORTED`），completed 但没有文本则为 `EMPTY_RESPONSE`。

`claude-code` 路由公布一份固定目录——Claude Opus／Sonnet／Haiku 家族，因为已安装的 Agent SDK 不提供任何枚举调用。`codex` 路由在首次读取其目录时（插件生命周期内仅一次）询问已安装的 `codex app-server` 它服务哪些模型（`model/list`），并公布这些模型；被 app-server 标记为 hidden 的条目不予公布。两条路由都另有一个 `native` 选项，意为「用 CLI 自己配置的默认——不发送任何覆盖」。选择目录里的模型会把 id 发给引擎（SDK `model`／app-server `turn/start model`）。

每个 `claude-code` 模型都公布 `off`／`low`／`medium`／`high`／`xhigh`／`max` 这些推理努力级别，调用方省略时 harness 物化 `high`。每个被发现的 `codex` 模型只公布它自己报告的级别，因此 `xhigh`、`max` 与 `ultra` 会出现在接受它们的模型上，默认值也用该模型自己报告的值；所选模型没有报告的级别会在任何 CLI 启动之前被拒绝。Codex `native` 公布完整的 app-server 词汇（harness 的 `off` 即协议上的 `minimal`）且不带 harness 默认值，因此省略级别时 CLI 自己的设置保持不变。

`model/list` 不报告容量，因此 `codex` 路由上的每个模型都采用 `codexContextWindow`，且不发送输出上限。当该查询无法应答时——`PATH` 上没有 `codex`、CLI 未登录、`codexDiscoveryTimeoutMs` 期限到达，或应答内容不被 app-server 协议适配器接受——该路由只公布 `native`，并通过 `ctx.logger.warn` 指明原因。绝不臆造模型 id，也不用固定列表顶替，因此选择器永远不会提供已安装 CLI 已经删除的 id。

## 组合

`@deepseek-ai/dsh-multi-provider` 组合包会连同两个后端一起挂载本适配器；可运行参考是 [`examples/multi-provider`](../../../examples/multi-provider/README.md)。profile 需要 `dsh-subagent`（在 `dsh-base` 里）加上下面两个后端行与本行。Codex 模型发现还需要 [`dsh-subprocess`](../../subprocess/subprocess/README.md)（在 `dsh-base` 里）；缺少它时 `codex` 路由只公布 `native`。

```yaml
- id: llm-engine
  name: '@deepseek-ai/dsh-llm-engine'

- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'

- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
```

不需要密钥：只要 `claude` 已登录 claude.ai 和／或 `codex` 已登录 ChatGPT。

| 键 | 默认值 | 含义 |
|---|---|---|
| `continuation` | `false` | 回合是否恢复引擎的长会话而不是每次重新开始。需要对应后端行也设置 `continuation: true`。 |
| `codexModelDiscovery` | `true` | `codex` 路由是否向已安装的 app-server 查询它服务的模型。关闭时——离线宿主，或者必须在每台机器上公布相同路由的组合——该路由只公布 `native`，且不启动任何子进程。 |
| `codexDiscoveryTimeoutMs` | `10000` | 正的有限期限（毫秒），不得大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)，同时覆盖 app-server 握手与 `model/list` 应答。 |
| `codexContextWindow` | `272000` | harness 为 `codex` 路由公布的每个模型假定的上下文窗口 token 数。app-server 不报告容量，而它自己的目录携带这个数值；该值供压缩使用。 |

## 权限决策

引擎的原生权限流程在其进程内生效（Claude Code 的审批、Codex 的 `approval_policy`）；不涉及 harness 的审批 seam。详见各后端 README 的权限姿态。

## 模型体验

### 提示词文本

#### 模型看到什么

引擎只收到最新一条用户消息的文本，作为一次全新运行里的单个任务。它看不到对话历史、harness 系统提示词或工具 schema；它自己的原生系统提示词、工具与权限在其进程内生效。

#### Token 影响

与数据相关；每次引擎运行支付一个独立的上下文，除记录下来的回答外不进入 harness 的派生历史。

#### KV Cache 影响

无；每次运行都是全新的引擎进程，使用自己的 provider 状态。


## 已知限制与暂缓事项

- **纯文本回合**——引擎的工具活动留在引擎进程内；会话日志不会为引擎回合记录工具调用（文本增量会实时到达，工具事件不会）。
- **续会话为可选项且写原生状态**——`continuation: true` 会把 Claude 会话文件与 Codex 线程持久化到原生 CLI 配置目录；默认的一次性姿态不触碰任何原生状态。
- **宿主 cwd**——引擎运行发生在宿主进程的 cwd，而不是会话的工作区。
- **拒绝辅助调用**——引擎会话的压缩与会话标题生成会失败；标题回退到 fallback 规则。
- **`claude-code` 目录是固定的**——Claude Agent SDK 不提供任何枚举调用，因此更新的 CLI 可能服务列表里还没有的模型（`native` 选项始终跟随 CLI 自己的默认）。
- **Codex 容量来自配置而非报告**——`model/list` 不携带上下文窗口，因此一个 `codexContextWindow` 覆盖该路由上的全部模型；真实容量不同的模型会按配置数值进行压缩。
- **Codex 发现只读一页并在插件生命周期内缓存**——app-server 用空游标应答其完整目录，而在 harness 运行期间升级的 CLI 在插件重新加载前不会被重新读取。
