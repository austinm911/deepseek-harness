# @deepseek-ai/dsh-multi-provider-demo

[English](README.md) | 中文

可运行的提供方目录与任务示例，用于可选的 multi-provider bundle。它会列出基于密钥的提供方，以及原生 Claude Code 和 Codex 订阅路线。

## 运行

```sh
pnpm run demo:multi-provider providers
pnpm run demo:multi-provider run --provider claude-code --model native "Reply with exactly: PONG"
pnpm run demo:multi-provider run --provider codex --model native "Reply with exactly: PONG"
```

原生路线使用现有的 `claude` 和 `codex` CLI 及其原生 OAuth 状态。基于密钥的路线使用组合配置提供的 credentials seam。

## 模型体验

### 提供方任务

#### 模型看到的内容

选中的提供方接收最新的直接任务文本。原生 engine 使用自己的系统提示词、工具、权限和产品上下文；Harness 不会转发完整会话或工具 schema。

#### Token 影响

基于密钥的提供方和原生 engine 分别承担上下文与输出 token。原生 engine 的工具活动保留在自己的 CLI 进程内。

#### KV Cache 影响

缓存复用由提供方负责。Harness 适配器不会在不同提供方路线之间共享缓存状态。

## 已知限制和后续工作

- 提供方模型目录是静态的，跟随已安装的 SDK 与 Codex app-server 版本。
- 原生 engine 路线要求对应 CLI 已安装并完成登录。
- 原生 engine 的继续会话状态保存在 CLI 自己的配置目录中。
