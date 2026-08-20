# Agent Note: The codex LLM route discovers its models from the installed app-server

Status: implemented

[English](2026-08-19-codex-route-live-model-discovery.md) | 中文

## 问题

`dsh-llm-engine` 公布 `codex` 路由的模型时，用的是一份照着 app-server 0.147.0 手工敲进去的常量：`gpt-5.3-codex` 配 400,000 token 上下文窗口、`gpt-5.3-codex-spark` 配 128,000、`native` 配 400,000，且全部以推理努力级别 `high` 为上限。

面对更新的 CLI，这里的每一条事实都是错的，而且每一条都以某种方式波及到用户。`codex-cli 0.148.0` 里不存在 `gpt-5.3-codex`，于是 Models 选择器提供了一个已失效的 id，选中它的会话会在第一个回合的 `turn/start` 处失败。两个方向上的容量都是臆造的——那个构建自己的目录对它服务的每个模型都报告 272,000 token——而 harness 所相信的数值正是压缩据以计算预算的依据，因此这条路由要么压缩了仍然装得下的对话，要么让它以为装得下的对话溢出。级别上限扣下了 `xhigh`、`max` 与 `ultra`，而这些模型确实接受它们，况且 `codexEffort` 遇到它们本来也会抛错。

固定写死并不是一个用更新的数字就能纠正的疏漏。app-server 由宿主安装与升级，与任何 harness 发布节奏都不同步，因此从用户执行 `npm i -g @openai/codex` 的那一刻起，常量就已经过期。Claude Code 路由面临同样的暴露，且无路可走：Agent SDK 不提供任何枚举调用。

## 决策

`codex` 路由去问 CLI。`dsh-subagent-codex` 中的 `listCodexModels(spec)` 通过子进程 seam 启动一个 `codex app-server --stdio` 子进程，完成 `initialize`／`initialized` 握手，发送 `model/list`，然后释放该子进程。`CodexAppServerWire.listModels` 负责解析：id、`displayName`、`supportedReasoningEfforts[].reasoningEffort` 与 `defaultReasoningEffort`，并扣下 `hidden` 条目。发现逻辑放在 `dsh-subagent-codex`，因为该包已经拥有 app-server 协议——argv、握手载荷、JSON-RPC 通信链路——于是 `dsh-llm-engine` 为这一个导出函数依赖它，而不是为同一套协议再长出第二个客户端。

**子进程的标准输入在释放前一直保持打开。** app-server 读到 EOF 就会退出，而不回应未完成的请求，因此写完三个帧就关闭管道只会得到没有应答、也没有错误的一个死掉的子进程。`stdio.stdin` 为 `'pipe'`，由 `disposeCodexChild` 负责结束它。

**惰性、带缓存，且绝不落在启动路径上。** `apply()` 注册路由，什么都不启动。适配器记忆化这个查询 promise，因此并发的选择器读取与回合准入在插件生命周期内共享同一个子进程。在 harness 运行期间升级的 CLI 在插件重新加载前不会被重新读取。

**降级只公布 `native`。** `PATH` 上没有 CLI、CLI 未登录、期限到达，或应答不被协议适配器接受，都会归结为仅有 `native` 一项，并把原因交给 `ctx.logger.warn`。刻意不提供固定的后备列表：提供已失效 id 的过期列表正是本次变更要消除的缺陷，而把它作为后备重新引入，恰好会在那些无法应答的宿主上重新引入它。

**推理努力级别按模型给出，拒绝是免费的。** 每个被发现的模型公布它自己报告的级别与自己的默认值，因此 `xhigh`、`max` 与 `ultra` 会出现在接受它们的位置。`LlmRuntime.resolveCallConfig` 本就会在任何 provider I/O 之前用 `UNSUPPORTED_REASONING_EFFORT` 拒绝模型 `reasoning.efforts` 之外的级别，因此按模型给出列表就是完整的修复。`codexEffort` 与新增的逆向 `harnessEffort` 共享一张覆盖 `minimal`…`ultra` 的 `EFFORT_VOCABULARY` 表，表外的级别在两个方向上都显式失败。`native` 公布完整词汇且不带 harness 默认值，因为应答里没有点名 CLI 所配置的模型，harness 也没有任何依据去收窄它。

**容量来自配置，而非臆造。** `model/list` 不携带上下文窗口，因此 `codexContextWindow`（默认 272,000，即 0.148.0 目录报告的数值）适用于该路由上的每个模型，而这条路由完全不发送输出上限——适配器从不向 CLI 发送 `maxTokens`。另外两个经校验的配置字段是 `codexDiscoveryTimeoutMs`（默认 10,000）与 `codexModelDiscovery`（默认 `true`）；`apply()` 会拒绝非正值，以及 Node 无法调度的期限。

`claude-code` 路由未作改动：固定目录、固定级别列表、调用方省略时物化 `high`。

## 确定性

发现让路由的目录成为关于宿主的事实，而先前有两个无密钥套件把它钉死。`examples/multi-provider/cordis.snapshot.yml` 设置 `codexModelDiscovery: false`，于是无论机器上是否安装 `codex`，已记录的 `providers` 列表都读作 `models: native`。`examples/multi-provider/tests/providers.spec.ts` 以开启发现的方式启动正式交付的 leaf，只断言该路由包含 `native`——这在服务七个模型的笔记本上成立，在一个模型都没有的 CI 宿主上同样成立。`codex` 子进程收集自己的 stderr 而不是继承它，因此 CLI 的诊断信息无法到达 harness 自己的 stderr，而这两个套件都会把它与 `''` 比较。

## 考虑过的替代方案

**把常量重新钉到 0.148.0。** 最省事的改法，也是最快失效的改法：它只在下一次 `npm i -g @openai/codex` 之前正确，而任何 harness 发布都观察不到那一刻。它也无法表达 CLI 真正会变化的东西——某个登录档位有权使用哪些模型、每个模型接受哪些级别——因此级别上限与臆造的容量会在这次编辑后继续存活。

**通过 subagent seam 暴露枚举**，做成可选的 `SubagentProvider.listModels`，让 `dsh-llm-engine` 不必依赖某个 provider 包。被否决：模型枚举是 LLM seam 的关切，而为一个消费方和一个提供方把它加进 subagent Service Definition，等于让某个消费方支配该约定。这条路由本来就按名字绑定到后端——适配器调用 `subagents.start('codex', …)`——因此一条 import 只是把既已存在的耦合说清楚。

**在 `dsh-llm-engine` 里直接基于 `JsonRpcLineTransport` 再写一个 `model/list` 客户端**，以避免依赖 provider 包。被否决：这会在第二处重复 argv、Windows 的 `cmd.exe` 边界、握手载荷与释放阶梯，而两份副本会在 app-server 下一次变更时发生漂移。

**遇到未知级别就跳过，而不是让查询失败。** 这能在 CLI 新增本表不认识的级别时存活下来，但它会静默收窄模型的真实能力，并且当被跳过的正是默认值时还需要按模型的后备逻辑。显式失败会把路由降级到 `native`、指明原因，并给出一目了然的修法：在 `EFFORT_VOCABULARY` 里加一行。

**按定时器或按请求刷新目录。** 被否决，因为这是没有当前消费方的成本：会话中途升级 CLI 很少见，而每次选择器读取都启动一个子进程并不少见，况且重新加载插件本来就会重新读取。

## 后果

选择器提供已安装 CLI 实际服务的内容，因此 `codex` 路由不再公布用起来就失败的 id，而 `xhigh`／`max`／`ultra` 成为可选项。压缩按 272,000 而非 400,000 或 128,000 计算预算，这改变了引擎会话何时压缩。没有 `codex` 的宿主现在看到一条路由、一个模型、一条警告，而不是三个跑不起来的模型；这是诚实的报告，也正是 CI 所看到的。

`dsh-llm-engine` 新增了对 `dsh-subagent-codex`、`dsh-subprocess` 与 `dsh-timeout` 的 peer dependency。第一个值得注意：只为 `claude-code` 路由组合这个适配器，现在也会安装 Codex 后端包。两个包在 `@deepseek-ai/dsh-multi-provider` 中一起交付，而这条路由无论如何都点名了该后端。

## 测试

`packages/llm/llm-engine/tests/codex-discovery.spec.ts` 挂载一个 `SubprocessRuntime` 子类来提供脚本化的 app-server，因此没有任何用例触及宿主的 CLI。它钉住：逐字取自 0.148.0 的 `model/list` 应答解析为路由模型、按模型的级别列表、被扣下的 `hidden` 条目、`native` 的完整词汇与缺失的默认值、并发与重复读取只启动一次子进程、`claude-code` 路由与关闭发现时都不启动子进程、对只报告到 `xhigh` 的模型选 `ultra` 时得到 `UNSUPPORTED_REASONING_EFFORT`，以及沉默的 CLI、缺失的 CLI、未登录的 CLI、畸形应答与未知级别这五种情况下带具名原因的仅 `native` 降级。`packages/subagent/subagent-codex/tests/subagent-codex.spec.ts` 钉住协议那一半：级别表的两个方向、解析及其四种拒绝、期限、提前退出与 spawn 级失败。

`examples/multi-provider/tests/snapshots/providers-listing.txt` 已针对关闭发现的回放 leaf 重新录制。真实路径通过真实组装应用得到验证——demo bin 在正式交付 leaf 上的 `providers` 列表报告来自 `codex-cli 0.148.0` 的 `gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, native`。
