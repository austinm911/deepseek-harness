# Agent Note: Claude subscription authentication paths

Status: implemented

English | [中文](2026-08-19-claude-subscription-auth-paths.zh.md)

## Problem

A Claude Pro/Max subscription is not an API key, and the two places a subscription could plausibly enter this harness each refuse it for a different reason.

The `claude-code` engine route spawns the Claude Code CLI through the official Agent SDK, so the CLI authenticates itself. On a host whose only Claude credential is the `sk-ant-oat01…` OAuth token that `claude setup-token` issues — no `~/.claude/.credentials.json`, no macOS `Claude Code-credentials` keychain item — the child never sees it: `scrubbedParentEnv()` (`packages/subprocess/subprocess/src/index.ts`) deletes every name matching `SENSITIVE_ENV_PATTERN` (`/KEY|PASSWORD|SECRET|TOKEN/i`) from the environment of every harness child, `CLAUDE_CODE_OAUTH_TOKEN` included, and the CLI reports `Not logged in`. The engine run then fails the session with `ENGINE_FAILURE`.

The harness's own agent loop has no subscription-backed Claude route at all. The `anthropic` route on `dsh-llm-pi-ai` resolves `ANTHROPIC_API_KEY` and sends it as a metered API key; a subscription token in that field is not what the Anthropic Messages endpoint accepts from an API-key client.

## Decision

A Claude subscription reaches this harness by two paths that coexist. The engine path is the default and the sanctioned one; the API path is opt-in.

**The engine path: the CLI owns the credential, and one name is forwarded explicitly.** `packages/subagent/subagent-claude-code` builds the Agent SDK child environment as `{ ...scrubbedParentEnv(), ...config.env }`, so the row's explicit `env` layer is the only way a credential-shaped name reaches that child. The `dsh-multi-provider` patch forwards exactly one name, `CLAUDE_CODE_OAUTH_TOKEN`, through a `!!js` expression that yields `{}` when the variable is unset. A host authenticated through the CLI's own credential store therefore composes and runs unchanged: an unset variable contributes no entry, and the child resolves credentials the way the CLI does on its own. `SENSITIVE_ENV_PATTERN` and `scrubbedParentEnv()` are unchanged, so ambient forwarding stays off for every other child, and no harness-specific alias of the token name is recognized: `CLAUDE_CODE_OAUTH_TOKEN` is the name the CLI itself reads, and a misspelling fails visibly instead of resolving.

**The API path: an `anthropic-subscription` pi-ai route, with no transport code owned here.** `@earendil-works/pi-ai@0.82.1`'s Anthropic Messages transport tests the resolved credential with `isOAuthToken(apiKey) => apiKey.includes('sk-ant-oat')`. On a match it sends the value as `authToken` (Bearer, `apiKey: null`), adds `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/<version>`, and `x-app: cli`, prepends a `You are Claude Code, Anthropic's official CLI for Claude.` system block, and normalizes tool names. Handing that transport a subscription token is the whole implementation, so the route is configuration: `api: anthropic-messages`, `baseURL: https://api.anthropic.com`, `apiKeyEnv: ANTHROPIC_OAUTH_TOKEN`, `displayName: Claude (Pro/Max subscription)`, models `claude-opus-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`. The key-based `anthropic` route (`ANTHROPIC_API_KEY`) is untouched; the two are separate routes on the same adapter, so one deployment serves both credential kinds and a session picks between them by model selection.

**Credential references only, on both paths.** Each path names an environment variable — `CLAUDE_CODE_OAUTH_TOKEN` in the forwarded child `env`, `ANTHROPIC_OAUTH_TOKEN` in `apiKeyEnv` — and no configuration, document, test, or fixture carries a token value. The API route's credential resolves per request through the credential seam, like every other pi-ai route, so a rotated token reaches the next request. Both rows live in the `dsh-multi-provider` patch that the [multi-provider pack note](2026-08-14-multi-provider-pack-and-engines.md) owns.

## Verification

The engine path is pinned by the CLI's own behavior: `claude -p` on a token-only host reports `Not logged in`, and the same invocation with `CLAUDE_CODE_OAUTH_TOKEN` set answers normally. The API path is pinned against the live endpoint: `POST https://api.anthropic.com/v1/messages` with the transport's OAuth headers and a subscription token returns HTTP 200 for each model the route advertises.

## Alternatives considered

**Reading Claude Code's own credential store.** Rejected. `~/.claude/.credentials.json` and the macOS `Claude Code-credentials` keychain item hold a short-lived access token plus a refresh token owned by a process the harness does not control. Consuming them means implementing refresh and writing the result back into a foreign store, racing the CLI's own rotation whenever both run, provoking keychain ACL prompts on macOS, and tracking an undocumented on-disk format that upstream may change at any release. A `claude setup-token` value needs none of that: it is long-lived, user-issued, and carried by one environment name.

**Relaxing the subprocess scrub.** Rejected. Narrowing `SENSITIVE_ENV_PATTERN` or exempting the token name would forward the token implicitly to every harness child — bash, terminals, language servers, every delegation backend — to serve the one child that needs it. The per-row explicit `env` layer already merges after the scrub and carries exactly the one name to exactly the one child.

**Owning an Anthropic OAuth transport.** Rejected against the [dependencies-over-hand-rolling policy](../process/2026-07-26-dependencies-over-hand-rolling.md): the installed pi-ai release already implements the OAuth-token detection, the Bearer switch, the Claude Code identity headers, and the tool-name normalization the endpoint requires, and a hand-rolled copy would own that drift.

**Making the API path the default, or the only path.** Rejected on the standing risk below. The CLI engine route is the path Anthropic sanctions for a subscription, so it stays the default; the API route is an opt-in route a deployment adds deliberately.

## Consequences

The API path authenticates a non-Claude-Code client with a Claude Pro/Max token while pi-ai presents Claude Code identity headers, which is Anthropic-ToS gray. That statement travels with the route wherever it is documented, and the CLI engine route remains the sanctioned default. A deployment that will not accept the risk composes the engine route and leaves `ANTHROPIC_OAUTH_TOKEN` unset; the route then fails loud with `MISSING_CREDENTIAL` naming the variable rather than degrading.

The engine path costs one explicit `env` entry in the shipped patch and keeps the subprocess scrub absolute for everything else. Its trade-off is that the forwarding is per-row: another composition that spawns Claude Code from its own row forwards the name itself, and the engine route in a profile without that entry authenticates only from the CLI's credential store.

The API path buys the harness loop, tools, session log, and approval seam on subscription-backed Claude models, which the engine path cannot give — an engine turn runs the CLI's own loop and records text only. It costs a second Claude credential kind to explain, and the two routes advertise overlapping model ids under different names.
