# @deepseek-ai/dsh-llm-engine

English | [中文](README.zh.md)

LLM-seam adapter for the local engine CLIs. Registers the `claude-code` and `codex` provider routes on `ctx.llm`, backed by the matching [`ctx.subagents`](../../subagent/subagent/README.md) backends: [`dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.md) runs the official Claude Agent SDK, [`dsh-subagent-codex`](../../subagent/subagent-codex/README.md) runs the official `codex app-server`. Selecting one of these routes as a session's provider — in the web Models picker, `agent-default-model`, or any model selection — routes every turn through the local CLI with its **native OAuth state (claude.ai / ChatGPT login); no API key of any kind**.

## What the adapter does

`stream()` takes the latest DIRECT user prompt's text (synthetic context injections such as AGENTS.md and skill catalogs are excluded by source kind), starts the matching backend through `ctx.subagents` with a cwd-bearing stub parent, forwards the engine's **live text deltas** as `text-delta` chunks while the run settles, and closes with the assembled final answer and a terminal finish. The engines are agents, not model endpoints: they execute their own tools inside their own process, so the harness loop sees text-only turns and the session log records the answers like any other assistant message. Engine runs are **never retried** (`maxRetries: 0`): a retry would execute the CLI twice.

**Long-lived sessions.** With `continuation: true` (plugin config plus the matching backend rows), the adapter keys an engine session per harness session id and resumes it on every later turn: Claude Code via the SDK's `resume` (`persistSession`), Codex via `thread/resume` on a persistent thread. The engine then remembers earlier turns of the same harness session — one conversation, not fresh-per-turn.

Refusal surfaces (all error finishes, no engine process started):

- **No user text** — `EMPTY_PROMPT`: the engines need a non-empty instruction.
- **Auxiliary purposes** — `UNSUPPORTED_PURPOSE`: compaction and session-title calls would spawn a full agent run for a side task.
- **Non-completed results** — `ENGINE_FAILURE` (or `ABORTED` for explicit cancellation), `EMPTY_RESPONSE` for a completed run with no text.

The `claude-code` route advertises a pinned catalog — the Claude Opus/Sonnet/Haiku families, because the installed Agent SDK exposes no enumeration call. The `codex` route asks the installed `codex app-server` which models it serves (`model/list`) on the first read of its catalog, once for the plugin's life, and advertises those; entries the app-server marks hidden are withheld. Both routes also offer a `native` choice meaning "the CLI's own configured default — no override sent". Selecting a catalog model sends the id to the engine (SDK `model` / app-server `turn/start model`).

Every `claude-code` model advertises the efforts `off`/`low`/`medium`/`high`/`xhigh`/`max`, and the harness materializes `high` when the caller omits one. Every discovered `codex` model advertises exactly the efforts it reported, so `xhigh`, `max`, and `ultra` appear on the models that accept them, with that model's own reported default; an effort the selected model does not report is refused before any CLI starts. Codex `native` advertises the whole app-server vocabulary (harness `off` is the wire's `minimal`) and no harness default, so an omitted effort leaves the CLI's own setting alone.

`model/list` reports no capacity, so every model on the `codex` route takes `codexContextWindow` and sends no output cap. The query itself is `dsh-subagent-codex`'s `listCodexModels(spec)`: one app-server child, one handshake, a single `model/list`, a check that each entry's reported default effort is among the efforts that entry reports, then disposal. When it cannot answer — no `codex` on `PATH`, a CLI that is not logged in, the `codexDiscoveryTimeoutMs` deadline passing, or a reply the app-server protocol adapter does not accept — the route advertises `native` alone and names the cause through `ctx.logger.warn`. No model id is invented and no pinned list stands in, so the picker never offers an id the installed CLI has dropped.

## Composition

The `@deepseek-ai/dsh-multi-provider` bundle mounts this adapter together with the two backends; the runnable reference is [`examples/multi-provider`](../../../examples/multi-provider/README.md). A profile needs `dsh-subagent` (in `dsh-base`) plus the two backend rows and this row. Codex model discovery also needs [`dsh-subprocess`](../../subprocess/subprocess/README.md) (in `dsh-base`); without it the `codex` route advertises `native` alone.

```yaml
- id: llm-engine
  name: '@deepseek-ai/dsh-llm-engine'

- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'

- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
```

No API key. Each CLI authenticates itself: `claude` against claude.ai, `codex` against ChatGPT (`~/.codex/auth.json`). Claude Code accepts an interactive login (OS keychain, or `~/.claude/.credentials.json`) or a subscription token from `claude setup-token`. A credential in the ambient environment does **not** reach the child: the [subprocess seam](../../subprocess/subprocess/README.md) strips credential-shaped names, so `CLAUDE_CODE_OAUTH_TOKEN` — and `ANTHROPIC_API_KEY`, which the SDK also accepts — reaches the CLI only when a backend row forwards it explicitly through `env`. The `@deepseek-ai/dsh-multi-provider` pack forwards `CLAUDE_CODE_OAUTH_TOKEN` for exactly this reason; a host authenticated by that token alone fails with `ENGINE_FAILURE` and the CLI's own `Not logged in` text without it.

| Key | Default | Meaning |
|---|---|---|
| `continuation` | `false` | Whether turns resume the engine's long-lived session instead of starting fresh. Requires `continuation: true` on the matching backend rows. |
| `codexModelDiscovery` | `true` | Whether the `codex` route queries the installed app-server for its models. With it off — an offline host, or a composition that must advertise the same route on every machine — the route advertises `native` alone and starts no child process. |
| `codexDiscoveryTimeoutMs` | `10000` | Positive finite deadline in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), covering the app-server handshake and the `model/list` reply together. |
| `codexContextWindow` | `272000` | Context-window tokens assumed for every model the `codex` route advertises. The app-server reports no capacity, and its own catalog carries this figure; the value feeds compaction. |

## Permission decisions

The engine's native permission flow applies inside its process (Claude Code's approvals, Codex's `approval_policy`); the harness approval seam is not involved. See each backend README's permission posture.

## Model Experience

### Prompt text

#### What the model sees

The `claude-code` and `codex` engines receive the latest user message text only, as one task in a fresh run. They never see the conversation history, the harness system prompt, or tool schemas; their native system prompts, tools, and permissions apply inside their processes.

#### Token effect

Data-dependent; each engine run pays for an independent context that never enters the harness's derived history beyond the recorded answer.

#### KV Cache effect

None; each run is a fresh engine process with its own provider state.


## Known Limitations and Deferred Work

- **Text-only turns** — engine tool activity stays inside the engine process; the session log records no tool calls for engine turns (streamed text deltas arrive live, tool events do not).
- **Continuation is opt-in and native-stateful** — `continuation: true` persists Claude session files and Codex threads under the native CLI config dirs; the one-shot default touches no native state.
- **Host cwd** — engine runs happen in the host process's cwd, not the session's workspace.
- **Auxiliary calls refused** — compaction and session-title generation fail for engine sessions; titles fall back to the fallback rules.
- **The `claude-code` catalog is pinned** — the Claude Agent SDK exposes no enumeration call, so a newer CLI may serve models the list does not yet name (the `native` choice always tracks the CLI's own default).
- **Codex capacity is configured, not reported** — `model/list` carries no context window, so one `codexContextWindow` covers every model on the route; a model whose real capacity differs is compacted against the configured figure.
- **Codex discovery reads one page and caches for the plugin's life** — the app-server answers its complete catalog with a null cursor, and a CLI upgraded while the harness runs is not re-read until the plugin reloads.
