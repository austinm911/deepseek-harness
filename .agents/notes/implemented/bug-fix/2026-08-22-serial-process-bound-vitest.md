# Agent Note: Serialise host-resource Vitest files

Status: implemented

English | [中文](2026-08-22-serial-process-bound-vitest.zh.md)

## Problem

The Vitest `process-bound` project identified tests that could not rely on worker-local isolation, but both projects used the `forks` pool after the Node 24 CJS-lexer stability change. The project name remained while its isolation guarantee became only an inventory label. The failure set moved between runs: a focused eight-file workload failed 3 of 5 runs, with failures in the ACP harness, exact-config HMR, and user-patch HMR files, while each file passed alone. The affected tests open Chokidar watchers, spawn real child processes, bind local HTTP servers, and wait on process I/O.

`scripts/oxlint-contract.spec.ts` added temporary TypeScript probes under `scripts/`, which is included by `tsconfig.host.json` as `scripts/**/*.ts`. A concurrent TypeScript program could discover a probe after creation and before cleanup; one observed failure reported the missing probe path from `tsconfig.host.json`.

## Decision

`process-bound` now guarantees forked execution with `fileParallelism: false`. A file belongs there when it touches a host resource that is not virtualized per worker, including file watchers, spawned process trees, local HTTP servers, fixed ports, or real operating-system state. The project now contains 13 such files, including the app-boot watcher files, SDK HTTP integration files, and ACP subprocess harness.

The Oxlint contract keeps its repository-relative project-resolution behavior but writes non-project probes under a unique repository-root `.oxlint-contract-<uuid>` directory. The directory is outside every TypeScript include glob and is not enumerated by another test; each probe and generated config removes itself in `finally`. The owning-project test keeps its probes in the real package, example, and website paths it verifies.

## Alternatives considered

**Increase watcher or subprocess deadlines.** Rejected because the failures were caused by undeclared host-resource overlap and fixture discovery, not a demonstrated product deadline. A larger timeout would preserve the scheduling dependency.

**Keep the two projects parallel because both use forks.** Rejected because fork workers isolate module state but do not serialize host watchers, process trees, ports, or operating-system state. The project contract would remain unenforced.

**Move only the tests that failed in one run.** Rejected because the rotating failure set is evidence of a shared isolation class. The project is defined by its resource contract, not by the last observed file name.

**Keep probes in a package fixture tree.** Rejected because `type-model.spec.ts` copies that tree wholesale, so a probe there remains a shared fixture resource. The owning-project test stays in real project directories because path placement is its contract; its temporary TypeScript paths are the behavior under test.

## Consequences

The process-bound project runs 13 files serially. The existing eight-file project measured 6.59 seconds in parallel and 15.76 seconds serially. A 12-file host-resource workload measured 7.79 seconds in parallel and 24.69 seconds serially, an approximately 17-second cost that buys a declared isolation guarantee in a roughly four-minute full suite.

The focused eight-file reproduction passed all five post-fix runs, and the serial process-bound project passed 13 files and 533 tests. Full-suite and static-gate results are recorded with the change validation.

One race is irreducible and remains. The owning-project test asserts which `tsconfig.json` claims a path, so its probes must sit in the real package, example, and website directories those projects include. Running `pnpm run typecheck` or `pnpm run lint` concurrently with `pnpm run test` can therefore still fail with `TS6053` naming a probe path. Both commands are correct; only their overlap is not. Run them in sequence.
