# Agent Note: Fork 上游同步足迹

Status: implemented

[English](2026-08-22-fork-upstream-sync-footprint.md) | 中文

## Problem

这个 checkout 是一个永久 fork。它携带以订阅认证的 Claude Code 与 Codex 引擎路由——`dsh-llm-engine`、`dsh-multi-provider` 包以及两个引擎演示——上游没有这些内容，而它们也永远不会送往上游。上游一直在前进：从 fork 点 `99f6f02fec` 到下面这次测量之间，上游落地了 743 个提交。

fork 在上游同样存在的文件里写下的每一行，都是未来每次同步时的一次合并冲突。只属于 fork 自己的文件里的行则毫无代价。这个 fork 当初并没有按这种不对称性来构建，因此它漂移进了一些并不承载 fork 专有行为的上游文件。

一次 `git merge upstream/master` 的空跑测量了真实代价，而不是靠改动频次去猜：**44 个冲突文件**，其中 18 个是叙述性文档、13 个是 `.i18n.yaml` 配对记录、11 个是源码、2 个是生成物。占据 70% 税负的是文档，而不是代码。

有三处改动比冲突更糟。`packages/bundle/headless/src/index.ts` 把上游内联的 `summarize()` 聚合替换成了对一个 fork 辅助函数的调用；`packages/llm/llm/src/content.ts` 与 `packages/core/session/src/index.ts` 携带着没有任何上游消费者的 fork 辅助函数。由于这三处在测量时都不与上游冲突，上游日后对那段被删除的 `summarize()` 循环所做的缺陷修复会干净地合并进来，然后被无声地丢弃。

## Decision

fork 专有的代码放在 fork 自己拥有的文件里。上游包目录内的一个新文件是免费的，因为上游没有该路径；而既有上游文件里的行不是。

**辅助函数回到 fork 拥有的包。** `textOfBlocks` 与 `lastAssistantText` 现在位于 `packages/llm/llm-engine/src/`，其消费者只有引擎适配器、两个演示以及 `examples/multi-provider` 的固件。`packages/llm/llm/src/content.ts`、`packages/core/session/src/index.ts` 与 `packages/bundle/headless/src/index.ts` 重新与 fork 点逐字节一致，因此上游自己的 `summarize()` 回来了，并将继续接收上游的修复。恢复后的内联循环与 fork 辅助函数现在重复了大约 14 行。这份重复是刻意的：共享这段代码需要改动一个上游文件，而这正是本次要去掉的代价。

**自包含的 fork 代码移入同级模块。** Claude 与 Codex 的推理努力度词汇表成为各自 provider 包中的 `effort.ts`；Codex 的目录接口成为 `catalog.ts`。带缓冲的更新通道此前被写了两遍，每个 provider 各一份，且都落在上游改动最频繁的两个文件里；现在它是唯一的 `packages/subagent/subagent/src/update-channel.ts`，位于两个 provider 本就依赖的接缝包中，因此没有引入新的依赖边。`subagent-codex/src/wire.ts` 还曾把 fork 声明插进它的 import 块中间，这保证了上游任何 import 改动都会冲突；它的 import 块现已重新连续且与上游完全一致。

留在内联位置的，是真正改变上游控制流的部分：Claude 的 `persistSession`／`resume`／`includePartialMessages` 选项及其 `is_error` 细节提取、Codex 的 `ephemeral: !continuation` 与 `thread/resume` 分支、穿入 `runTurn` 的 `model` 与 `effort`、`item/agentMessage/delta` 处理器，以及 `continuation` 配置字段。这就是不可再削减的 fork。

**共享文档只在有关卡强制时才保留。** 把每一个被触及的共享文档回退到 fork 点再跑关卡表明，`verify-md-links`、`verify-translation-pairing` 与 `verify-doc-budgets` 全部通过；只有 `verify-type-equiv` 在 `docs/subsystems/subagent.md` 第 15 与 39 行失败，因为 fork 增加了 `continuation` 与 `reasoningEffort` 能力标志及其请求选项。因此保留 `docs/subsystems/subagent.*`，而回退 `docs/architecture.*`、`docs/defensive-patterns.*`、`docs/event-producer-consumer.*`、`docs/subsystems/session.*`、`examples/README.*` 与 `packages/bundle/README.*`。关于 fork 自身行为的叙述属于 `packages/llm/llm-engine/README.md` 与 `packages/bundle/multi-provider/README.md`。

测量结果是 **26 个冲突文件**，其中 11 个是重新生成而非人工解决。

## Consequences

现在一次同步的冲突文件是 26 个而不是 44 个，其中 11 个是重新生成而非人工解决，因此需要人工解决的面是 15 个。rebase 或 merge 到 `upstream/master`，然后按类别处理冲突。`rerere` 已启用，因此在多次尝试之间重复的同一处解决会被回放。

1. **重新生成，绝不手工解决**——`pnpm-lock.yaml`（`pnpm install --lockfile-only`）、`packages/extensions/tool-cordis/src/api-catalog.ts`（`pnpm run gen-cordis-catalog`）、`docs/module-graph.*`（`pnpm run gen-module-graph`）、`docs/config-catalog.*`（`pnpm run gen-config-catalog`）、`docs/event-producer-consumer.*`（`pnpm run gen-doc-graphs`）。任取一侧，然后运行生成器并信任它的输出。
2. **中文一侧需手工带上。** 每个生成器只写英文。在这些文档内部，mermaid 块与生成的表格行不含中文，因此英文区域可逐字作为权威；只有周围的叙述是翻译的。随后运行 `pnpm run verify-translation-pairing --write <doc>`。
3. **解决源码冲突。** 十二处中的九处是两个 provider 包及其 spec；对上面列出的内联项保留 fork 一侧，其余取上游一侧。`packages/subagent/subagent/src/out-of-process.ts` 与 `scripts/check-workspace-constraints.ts` 是增量式的单行改动。
4. **重新录制转录。** 无密钥用 `pnpm run test:snapshot`，有密钥用 `pnpm run test:snapshot:record`。固件会无声腐化；这一步就是用来抓住它的。
5. **验证。** `pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`、`pnpm vitest run packages/subagent packages/llm`、`pnpm run test:snapshot`。

在诊断失败之前有两个宿主事实值得知道。`pnpm run test` 在负载较高的机器上不稳定：失败集合每次运行都不同，在 `HEAD` 上比应用了这些改动后更多，而且每个单独的失败在隔离运行时都通过——原因是文件监视、进程树以及 30 秒的子进程期限。另外，`pnpm run rescope-vendor:check` 在 `HEAD` 上报告 26 处既有残留，与 fork 内容无关。

## Alternatives considered

**为生成文件配置 `.gitattributes` 合并驱动。** 自 fork 点以来 `.gitattributes` 没有收到任何上游提交，因此在那里注册驱动几乎免费，而且仓库已经为 `*.i18n.yaml` 提供了一个。已拒绝：一旦生成文件清单发生漂移，无声地取用某一侧的驱动就会变错，而且这种失败是不可见的。显式的重新生成步骤是同样的工作量，但结果可见。

**把普遍有用的部分推向上游。** `CLAUDE_CODE_OAUTH_TOKEN` 的转发修复了一个真实的上游缺陷，因为上游自己的 Claude 后端在仅有令牌的宿主上同样失败，而 `SubagentResult.failure` 与 `listCodexModels` 会让任何消费者受益。已按指令拒绝：不向 `deepseek-ai` 发送任何改动。其后果是 `subagent-claude-code/src/run.ts` 与 `subagent-codex/src/wire.ts` 会一直是冲突点。

**共享恢复后的 `summarize()` 逻辑。** 已拒绝：任何共享机制都会把 fork 的行重新放回 `packages/bundle/headless/src/index.ts` 或 `packages/core/session/src/index.ts`，而这正是本次改动所消除的无声分歧风险。
