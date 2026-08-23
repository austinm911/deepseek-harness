# Agent Note：串行运行进程绑定的 Vitest 文件

Status: implemented

[English](2026-08-22-serial-process-bound-vitest.md) | 中文

## Problem

Vitest 的 `process-bound` 项目标识了不能依赖 worker 本地隔离的测试，但 Node 24 CJS lexer 稳定性变更之后，两个项目都使用 `forks` pool。项目名称仍在，隔离保证却退化为仅供清单使用。失败集合会在运行之间变化：一个包含 8 个文件的聚焦工作负载有 5 次中失败 3 次，失败分别出现在 ACP harness、精确配置 HMR 和用户补丁 HMR 文件，而每个文件单独运行都能通过。受影响的测试会打开 Chokidar watcher、生成真实子进程、绑定本地 HTTP 服务器，并等待进程 I/O。

`scripts/oxlint-contract.spec.ts` 会在 `scripts/` 下写入临时 TypeScript probe，而 `tsconfig.host.json` 将 `scripts/**/*.ts` 纳入 include。并发 TypeScript 程序可能在 probe 创建后、清理前发现它；一次观测到的失败来自 `tsconfig.host.json` 报告 probe 路径已不存在。

## Decision

`process-bound` 现在保证使用 fork 工作进程，并设置 `fileParallelism: false`。测试触及未按 worker 隔离的宿主资源时归入此项目，包括文件 watcher、生成的进程树、本地 HTTP 服务器、固定端口或真实操作系统状态。该项目现在包含 13 个文件，其中包括 app-boot watcher、SDK HTTP 集成和 ACP 子进程 harness。

Oxlint contract 保留仓库内相对路径的项目解析行为，但会把不需要项目归属的 probe 写入唯一的仓库根目录 `.oxlint-contract-<uuid>`。该目录不匹配任何 TypeScript include glob，也不会被其他测试枚举；每个 probe 和生成的 config 都会在 `finally` 中删除。项目归属测试仍把 probe 写入它验证的真实包、示例和网站路径。

## Alternatives considered

**增加 watcher 或子进程截止时间。** 拒绝，因为失败来自未声明的宿主资源重叠和 fixture 发现，而不是已测得的产品截止时间不足。更长的超时仍会保留对调度时序的依赖。

**两个项目继续并行，因为它们都使用 forks。** 拒绝，因为 fork worker 能隔离模块状态，却不会串行化宿主 watcher、进程树、端口或操作系统状态。项目契约仍然不会被执行。

**只移动某一次运行中失败的测试。** 拒绝，因为变化的失败集合说明它们属于共同的隔离类别。项目应由资源契约定义，而不是由上一次观测到的文件名定义。

**把 probe 保留在包 fixture 树中。** 拒绝，因为 `type-model.spec.ts` 会整体复制该树，probe 仍然会成为共享 fixture 资源。项目归属测试保留真实项目目录，因为路径位置就是它的契约；其中的临时 TypeScript 路径正是被测试的行为。

## Consequences

进程绑定项目会串行运行 13 个文件。现有 8 文件项目的实测并行耗时为 6.59 秒，串行耗时为 15.76 秒。12 文件宿主资源工作负载的实测并行耗时为 7.79 秒，串行耗时为 24.69 秒，约增加 17 秒；对于约 4 分钟的完整套件，这换来了明确的隔离保证。

聚焦的 8 文件复现工作负载在修复后连续 5 次通过，串行进程绑定项目也通过了 13 个文件和 533 个测试。完整套件与静态门禁的结果随本次变更记录。

有一处竞态不可再消除，仍然存在。归属项目测试断言的正是哪个 `tsconfig.json` 声明了某条路径，因此它的探针必须位于那些项目所包含的真实 package、example 与 website 目录中。于是把 `pnpm run typecheck` 或 `pnpm run lint` 与 `pnpm run test` 并发运行，仍可能以 `TS6053` 失败并指名某个探针路径。两条命令本身都是正确的，只有它们的重叠不正确。请顺序运行。
