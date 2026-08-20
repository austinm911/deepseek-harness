# Agent Note: The codex LLM route discovers its models from the installed app-server

Status: implemented

English | [中文](2026-08-19-codex-route-live-model-discovery.zh.md)

## Problem

`dsh-llm-engine` advertised the `codex` route's models from a constant hand-typed against app-server 0.147.0: `gpt-5.3-codex` with a 400,000-token context window, `gpt-5.3-codex-spark` with 128,000, and `native` with 400,000, all capped at effort `high`.

Every one of those facts was wrong against a newer CLI, and each was wrong in a way that reached a user. `gpt-5.3-codex` does not exist in `codex-cli 0.148.0`, so the Models picker offered a dead id and a session that selected it failed its first turn at `turn/start`. The capacities were fiction in both directions — that build's own catalog reports 272,000 tokens for every model it serves — and the figure the harness believes is what compaction budgets against, so the route either compacted a conversation that still fit or overflowed one it thought fit. The effort ceiling withheld `xhigh`, `max`, and `ultra`, which the models do accept, and `codexEffort` would have thrown on them anyway.

The pinning was not an oversight to correct with fresher numbers. The app-server is installed and upgraded by the host, out of step with any harness release, so a constant is stale from the moment a user runs `npm i -g @openai/codex`. The Claude Code route has the same exposure with no way out: the Agent SDK exposes no enumeration call.

## Decision

The `codex` route asks the CLI. `listCodexModels(spec)` in `dsh-subagent-codex` starts one `codex app-server --stdio` child through the subprocess seam, performs the `initialize`/`initialized` handshake, sends `model/list`, and disposes the child. `CodexAppServerWire.listModels` owns the parse: id, `displayName`, `supportedReasoningEfforts[].reasoningEffort`, and `defaultReasoningEffort`, with `hidden` entries withheld. Discovery lives in `dsh-subagent-codex` because that package already owns the app-server protocol — the argv, the handshake payload, the JSON-RPC wire — and `dsh-llm-engine` now depends on it for the one exported function rather than growing a second client for the same protocol.

**The child's stdin stays open until disposal.** The app-server exits on EOF without answering outstanding requests, so writing the three frames and closing the pipe yields no reply and no error, just a dead child. `stdio.stdin` is `'pipe'` and `disposeCodexChild` is what ends it.

**Lazy, cached, and never on the boot path.** `apply()` registers the routes and starts nothing. The adapter memoizes the query promise, so concurrent picker reads and turn admissions share one child process for the plugin's life. A CLI upgraded while the harness runs is not re-read until the plugin reloads.

**Degradation advertises `native` alone.** No CLI on `PATH`, a CLI that is not logged in, the deadline passing, or a reply the protocol adapter does not accept all resolve to the single `native` entry with the cause on `ctx.logger.warn`. A pinned fallback list is deliberately absent: a stale list offering a dead id is the defect this change removes, and reintroducing it as a fallback would reintroduce it on exactly the hosts that cannot answer.

**Efforts are per model, and rejection is free.** Each discovered model advertises the levels it reported and its own default, so `xhigh`, `max`, and `ultra` appear where they are accepted. `LlmRuntime.resolveCallConfig` already refuses an effort outside a model's `reasoning.efforts` with `UNSUPPORTED_REASONING_EFFORT` before any provider I/O, so per-model lists are the whole fix. `codexEffort` and its new inverse `harnessEffort` share one `EFFORT_VOCABULARY` table covering `minimal`…`ultra`, and a level outside it fails loud in both directions. `native` advertises the full vocabulary with no harness default, because the CLI's configured model is not named in the reply and the harness has nothing to narrow it with.

**Capacity is configuration, not invention.** `model/list` carries no context window, so `codexContextWindow` (default 272,000, the figure the 0.148.0 catalog reports) applies to every model on the route, and the route sends no output cap at all — the adapter never sends `maxTokens` to a CLI. `codexDiscoveryTimeoutMs` (default 10,000) and `codexModelDiscovery` (default `true`) are the other two validated fields; `apply()` refuses a non-positive value or a timeout Node cannot schedule.

The `claude-code` route is untouched: pinned catalog, pinned effort list, `high` materialized when the caller omits one.

## Determinism

Discovery makes the route's catalog a fact about the host, which two keyless suites previously pinned. `examples/multi-provider/cordis.snapshot.yml` sets `codexModelDiscovery: false`, so the recorded `providers` listing reads `models: native` on every machine, with or without a `codex` install. `examples/multi-provider/tests/providers.spec.ts` boots the shipping leaf with discovery on and asserts only that the route contains `native`, which holds on a laptop serving seven models and on a CI host serving none. The `codex` child collects its stderr instead of inheriting it, so a CLI diagnostic cannot reach the harness's own stderr, which both suites compare against `''`.

## Alternatives considered

**Re-pin the constant to 0.148.0.** The cheapest change and the one that loses fastest: it is correct until the next `npm i -g @openai/codex`, which no harness release can observe. It also cannot express what the CLI actually varies — which models a login tier is entitled to, and which efforts each model takes — so the effort ceiling and the invented capacities would survive the edit.

**Surface enumeration through the subagent seam** as an optional `SubagentProvider.listModels`, keeping `dsh-llm-engine` free of a provider dependency. Rejected: model enumeration is an LLM-seam concern, and adding it to the subagent Service Definition for one consumer and one provider would let a consumer dictate that contract. The route is already bound to the backend by name — the adapter calls `subagents.start('codex', …)` — so an import states a coupling that already exists.

**Write a second `model/list` client in `dsh-llm-engine`** over `JsonRpcLineTransport` directly, avoiding the dependency on a provider package. Rejected: it duplicates the argv, the Windows `cmd.exe` boundary, the handshake payload, and the disposal ladder in a second place, and the two copies would drift on the next app-server change.

**Skip an unknown effort level instead of failing the query.** It survives a CLI that adds a level this table does not know, but it silently narrows a model's real capability and would need per-model fallbacks for a default that was skipped. A loud failure degrades the route to `native`, names the cause, and has an obvious repair: one row in `EFFORT_VOCABULARY`.

**Refresh the catalog on a timer or per request.** Rejected as a cost with no current consumer: a CLI upgrade mid-session is rare, spawning a child per picker read is not, and reloading the plugin already re-reads.

## Consequences

The picker offers what the installed CLI serves, so the `codex` route stops advertising ids that fail on use, and `xhigh`/`max`/`ultra` become selectable. Compaction budgets against 272,000 rather than 400,000 or 128,000, which changes when engine sessions compact. A host with no `codex` now sees one route with one model and one warning instead of three models that cannot run; that is the honest report, and it is also what CI sees.

`dsh-llm-engine` gained peer dependencies on `dsh-subagent-codex`, `dsh-subprocess`, and `dsh-timeout`. The first is the notable one: composing the adapter for the `claude-code` route alone now installs the Codex backend package. Both packages ship together in `@deepseek-ai/dsh-multi-provider`, and the route names the backend either way.

## Testing

`packages/llm/llm-engine/tests/codex-discovery.spec.ts` mounts a `SubprocessRuntime` subclass serving a scripted app-server, so no case reaches the host's CLI. It pins the parse of a verbatim 0.148.0 `model/list` reply into route models, per-model effort lists, the withheld `hidden` entry, `native`'s full vocabulary and absent default, one spawn for concurrent and repeated reads, no spawn for the `claude-code` route or with discovery off, `UNSUPPORTED_REASONING_EFFORT` for `ultra` on a model that reported only `xhigh`, and native-only degradation with a named cause for a silent CLI, an absent CLI, a not-logged-in CLI, a malformed reply, and an unknown effort level. `packages/subagent/subagent-codex/tests/subagent-codex.spec.ts` pins the protocol half: both directions of the effort table, the parse and its four rejections, the deadline, an early exit, and a spawn-level failure.

`examples/multi-provider/tests/snapshots/providers-listing.txt` is re-recorded against the discovery-disabled replay leaf. The live path was verified through the real assembled application — the demo bin's `providers` listing over the shipping leaf reports `gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, native` from `codex-cli 0.148.0`.
