# @deepseek-ai/dsh-engine-session-demo

[English](README.md) | 中文

实验性的整会话示例，将一个持久 Harness 会话通过原生 Claude Code 或 Codex engine 运行。原生 CLI 自己负责工具、权限、模型上下文与订阅认证，Harness 负责记录产生的会话日志。

## 运行

```sh
pnpm run demo:engine-session claude-code "fix the failing test in this repo"
pnpm run demo:engine-session codex "summarize the git log"
```

两个 engine 都使用原生 OAuth 状态。Claude 必须登录 claude.ai，Codex 必须登录 ChatGPT。

## 模型体验

### Engine 会话

#### 模型看到的内容

选中的原生 engine 接收任务文本，并使用自己的系统提示词、工具、权限和产品上下文。Harness 会话历史不会复制到 engine 请求中。

#### Token 影响

原生 engine 独立承担自己的上下文和轮次成本。内部工具活动和推理保留在产品进程内。

#### KV Cache 影响

缓存行为由原生 CLI 和提供方负责。Harness 不会与 engine 共享 parent 会话的缓存。

## 已知限制和后续工作

- 示例会话只记录 engine 的最终文本。
- 原生工具活动和审批不会表示为 Harness 工具事件。
- 示例每个会话只运行一个任务，多轮继续由 `llm-engine` 提供方负责。
