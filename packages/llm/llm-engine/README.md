# @deepseek-ai/dsh-llm-engine

English | [中文](README.zh.md)

Chat-model routes for the local engine CLIs. The plugin registers the `codex` and `claude-code` provider routes on `ctx.llm`. Selecting one in the Models picker, `agent-default-model`, or any model selection runs every turn through the packaged Codex app-server or Claude Agent SDK, authenticated by the CLI's own login (ChatGPT for Codex, claude.ai for Claude Code). No API key is involved.

## Install

The package is a Profile Bundle. Its `cordis.patch.yml` inserts the `llm-engine` row, so installing it into a profile is enough:

```sh
pnpm pack                                    # in this directory
dsh plugin --profile <name> add /path/to/deepseek-ai-dsh-llm-engine-<version>.tgz
```

The desktop profile is managed by the app. Install through **Settings → Plugins → Install** with the tarball path, or add the tarball to `~/.dsh/profiles/desktop` while the app is closed.

`lib/index.js` inlines this repository's `dsh-subagent-codex` and `dsh-subagent-claude-code` run starters. Every other `@deepseek-ai/*` import is a peer the Harness installation already ships. `@openai/codex` and `@anthropic-ai/claude-agent-sdk` are ordinary dependencies, so the profile carries its own CLI versions.

## Behavior

- **Prompt.** An engine receives the latest direct user message only. Context injections (AGENTS.md, skill catalogs, tool results) are skipped. The Harness system prompt, history, and tools are never sent. The engine runs its own tools in its own process, scoped to the session's working directory.
- **Continuation.** With `continuation` on (the default), each Harness session keeps one native Codex thread and one Claude session. Their ids are stored in the `llm_engine_sessions` storage domain, so a session reopened after a restart resumes the same engine conversation. A resumed turn that fails (not one that is cancelled) drops the stored id and says so in the error, because the native conversation may be gone (Claude Code prunes old transcripts). The next message then starts a new engine conversation.
- **Streaming.** Live answer text streams as deltas. The block-end text is the engine's final answer.
- **Models.** Each route asks its packaged CLI for its catalog once per plugin life: Codex through app-server `model/list`, Claude through the Agent SDK's `supportedModels()`. Models are listed after `native` (the CLI's configured default). When discovery fails, only `native` is offered and the cause is logged. A model id the catalog does not list still resolves, so a saved session keeps working and the CLI decides whether it serves that model.
- **Efforts.** The harness `off` effort becomes Codex `minimal` and Claude disabled thinking. Other efforts pass through unchanged.
- **Refusals.** Compaction and session-title calls finish with `UNSUPPORTED_PURPOSE`. A turn without a session working directory finishes with `NO_WORKSPACE`. Engine failures finish with `ENGINE_FAILURE` and carry the engine's diagnostic, such as an expired login. Engine turns are never retried.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `continuation` | `true` | Resume one native engine session per Harness session and route |
| `modelDiscovery` | `true` | Ask each route's CLI for its catalog |
| `discoveryTimeoutMs` | `10000` | Deadline for one discovery query, handshake included |
| `codexContextWindow` | `272000` | Context window assumed for every `codex` model, used by compaction |
| `claudeContextWindow` | `1000000` | Context window assumed for every `claude-code` model, used by compaction |
| `codexPermissionMode` | `approve-for-me` | Codex mode: `never`, `approve-for-me` (workspace-write sandbox, auto reviewer), or `dangerously-bypass-approvals-and-sandbox` |
| `claudePermissionMode` | `acceptEdits` | Claude Code mode: `dontAsk`, `acceptEdits`, `auto`, `plan`, or `bypassPermissions` |
| `claudeEnv` | `{}` | Environment forwarded to the Claude child; the bundle forwards `CLAUDE_CODE_OAUTH_TOKEN` when it is set |
| `disposeGraceMs` | `3000` | Grace between process-tree termination tiers |

## Known limitations

- **Old Codex CLIs are refused.** A ChatGPT login rejects current models on older Codex CLIs ("model is not supported when using Codex with a ChatGPT account"). Bump the `@openai/codex` dependency when that happens.
- **Capacity is configured, not reported.** Neither catalog carries a context window, so `codexContextWindow` and `claudeContextWindow` apply to every model on their route.
- **Stored native ids are not pruned.** Records are a few bytes per session, and there is no session-deletion event to prune them on.
