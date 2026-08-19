# @deepseek-ai/dsh-engine-session-demo

English | [中文](README.zh.md)

Experimental whole-session demo that routes one durable Harness session through the native Claude Code or Codex engine. The native CLI owns its tools, permissions, model context, and subscription authentication; Harness records the resulting transcript.

## Run

```sh
pnpm run demo:engine-session claude-code "fix the failing test in this repo"
pnpm run demo:engine-session codex "summarize the git log"
```

Both engines use their native OAuth state. Claude must be logged into claude.ai and Codex must be logged into ChatGPT.

## Model Experience

### Engine session

#### What the model sees

The selected native `claude-code` or `codex` engine receives the task text and uses its own system prompt, tools, permissions, and product context. Harness session history is not copied into the engine request.

#### Token effect

The native engine pays for its own context and turn. Its internal tool activity and reasoning remain inside the product process.

#### KV Cache effect

Cache behavior is owned by the native CLI and provider. Harness does not share the parent session's cache with the engine.

## Known Limitations and Deferred Work

- Only the engine's final text is recorded in the demo transcript.
- Native tool activity and approvals are not represented as Harness tool events.
- This demo runs one task per session. The `llm-engine` provider owns multi-turn continuation.
