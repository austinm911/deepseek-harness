# Agent Note: Fork upstream-sync footprint

Status: implemented

English | [中文](2026-08-22-fork-upstream-sync-footprint.zh.md)

## Problem

This checkout is a permanent fork. It carries subscription-authenticated Claude Code and Codex engine routes — `dsh-llm-engine`, the `dsh-multi-provider` pack, and the two engine demos — that upstream does not have and that will never be sent upstream. Upstream keeps moving: 743 commits landed between fork point `99f6f02fec` and the measurement below.

Every line the fork places in a file that also exists upstream is a merge conflict on every future sync. Lines in files only the fork owns cost nothing. The fork was not built with that asymmetry in mind, so it had drifted into upstream files that carried no fork-specific behavior.

A dry-run `git merge upstream/master` measured the real cost rather than guessing from churn counts: **44 conflicting files**, of which 18 were prose docs, 13 were `.i18n.yaml` pairing records, 11 were source, and 2 were generated. Documentation, not code, was 70% of the tax.

Three edits were worse than a conflict. `packages/bundle/headless/src/index.ts` had upstream's inline `summarize()` accumulation replaced by a call to a fork helper; `packages/llm/llm/src/content.ts` and `packages/core/session/src/index.ts` carried fork helpers with no upstream consumer. Because none of those three conflicted against upstream at measurement time, a future upstream bug fix inside that deleted `summarize()` loop would have merged clean and been silently discarded.

## Decision

Fork-only code lives in files the fork owns. A new file inside an upstream package directory is free, because upstream has no such path; lines inside an existing upstream file are not.

**Helpers went back to fork-owned packages.** `textOfBlocks` and `lastAssistantText` now live in `packages/llm/llm-engine/src/`, whose only consumers are the engine adapter, the two demos, and the `examples/multi-provider` fixtures. `packages/llm/llm/src/content.ts`, `packages/core/session/src/index.ts`, and `packages/bundle/headless/src/index.ts` are byte-identical to fork point again, so upstream's own `summarize()` is back and will receive upstream's fixes. The restored inline loop and the fork helper now duplicate roughly 14 lines. That duplication is deliberate: sharing the code would require an edit to an upstream file, which is the cost being removed.

**Self-contained fork code moved to sibling modules.** The Claude and Codex reasoning-effort vocabularies became `effort.ts` in each provider package; the Codex catalog surface became `catalog.ts`. The buffered update channel had been written twice, once in each provider, in the two files upstream churns most; it is now one `packages/subagent/subagent/src/update-channel.ts` in the seam package both providers already depend on, so no new dependency edge was introduced. `subagent-codex/src/wire.ts` also had fork declarations spliced into the middle of its import block, guaranteeing a conflict on any upstream import change; its import block is contiguous and upstream-exact again.

What stays inline is what genuinely alters upstream control flow: Claude's `persistSession`/`resume`/`includePartialMessages` options and its `is_error` detail extraction, Codex's `ephemeral: !continuation` and `thread/resume` branch, the `model` and `effort` threading into `runTurn`, the `item/agentMessage/delta` handler, and the `continuation` config fields. That is the irreducible fork.

**Shared documentation survives only when a gate forces it.** Reverting every touched shared doc to fork point and running the gates showed `verify-md-links`, `verify-translation-pairing`, and `verify-doc-budgets` all pass; only `verify-type-equiv` fails, on `docs/subsystems/subagent.md` lines 15 and 39, because the fork adds the `continuation` and `reasoningEffort` capability flags and their request options. So `docs/subsystems/subagent.*` is kept and `docs/architecture.*`, `docs/defensive-patterns.*`, `docs/event-producer-consumer.*`, `docs/subsystems/session.*`, `examples/README.*`, and `packages/bundle/README.*` are reverted. Prose about the fork's own behavior belongs in `packages/llm/llm-engine/README.md` and `packages/bundle/multi-provider/README.md`.

The measured result is **26 conflicting files**, and 11 of those are regenerated rather than resolved.

## Consequences

A sync now conflicts on 26 files instead of 44, and 11 of those are regenerated rather than resolved, so the hand-resolution surface is 15. Rebase or merge onto `upstream/master`, then work the conflicts by class. `rerere` is enabled, so a resolution repeated across attempts is replayed.

1. **Regenerate, never hand-resolve** — `pnpm-lock.yaml` (`pnpm install --lockfile-only`), `packages/extensions/tool-cordis/src/api-catalog.ts` (`pnpm run gen-cordis-catalog`), `docs/module-graph.*` (`pnpm run gen-module-graph`), `docs/config-catalog.*` (`pnpm run gen-config-catalog`), `docs/event-producer-consumer.*` (`pnpm run gen-doc-graphs`). Take either side, then run the generator and trust its output.
2. **Bring the Chinese side along by hand.** Every generator writes English only. Inside these documents the mermaid blocks and the generated table rows contain no Chinese, so the English regions are authoritative verbatim; only the surrounding prose is translated. Then `pnpm run verify-translation-pairing --write <doc>`.
3. **Resolve the source conflicts.** Nine of the twelve are the two provider packages plus their specs; keep the fork side for the inline items listed above and take upstream's side for everything else. `packages/subagent/subagent/src/out-of-process.ts` and `scripts/check-workspace-constraints.ts` are additive one-liners.
4. **Re-record the transcripts.** `pnpm run test:snapshot` keyless, or `pnpm run test:snapshot:record` with a key. Fixtures rot silently; this is the step that catches it.
5. **Verify.** `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `pnpm vitest run packages/subagent packages/llm`, `pnpm run test:snapshot`.

Two host facts worth knowing before diagnosing a failure. `pnpm run test` is flaky on a loaded machine: the failing set varies run to run, is larger at `HEAD` than with these changes applied, and every individual failure passes in isolation — file watching, process trees, and 30-second subprocess deadlines are the causes. And `pnpm run rescope-vendor:check` reports 26 pre-existing residues at `HEAD`, unrelated to fork content.

## Alternatives considered

**A `.gitattributes` merge driver for the generated files.** `.gitattributes` has taken zero upstream commits since fork point, so a driver registration there would be nearly free, and the repo already ships one for `*.i18n.yaml`. Rejected: a driver that silently takes one side becomes wrong the moment the generated-file list drifts, and the failure is invisible. An explicit regeneration step is the same work with a visible result.

**Upstreaming the generally useful parts.** The `CLAUDE_CODE_OAUTH_TOKEN` forward fixes a real upstream bug, since upstream's own Claude backend also fails on a token-only host, and `SubagentResult.failure` and `listCodexModels` would benefit any consumer. Rejected by instruction: no changes are sent to `deepseek-ai`. The consequence is that `subagent-claude-code/src/run.ts` and `subagent-codex/src/wire.ts` stay permanent conflict sites.

**Sharing the restored `summarize()` logic.** Rejected: any sharing mechanism puts fork lines back into `packages/bundle/headless/src/index.ts` or `packages/core/session/src/index.ts`, which is exactly the silent-divergence risk this change removes.
