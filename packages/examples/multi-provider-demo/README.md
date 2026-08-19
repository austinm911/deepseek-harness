# @deepseek-ai/dsh-multi-provider-demo

English | [中文](README.zh.md)

Runnable provider catalog and task demo for the optional multi-provider bundle. It lists key-based providers together with the native Claude Code and Codex subscription routes.

## Run

```sh
pnpm run demo:multi-provider providers
pnpm run demo:multi-provider run --provider claude-code --model native "Reply with exactly: PONG"
pnpm run demo:multi-provider run --provider codex --model native "Reply with exactly: PONG"
```

The native routes use the existing `claude` and `codex` CLI installations and their native OAuth state. Key-based routes use the credential seam configured by the composition.

## Model Experience

### Provider task

#### What the model sees

The selected provider receives the latest direct task text. Native `claude-code` and `codex` routes use their own system prompt, tools, permissions, and product context; Harness does not forward its full conversation or tool schema.

#### Token effect

Key-based providers and native engines account for context and output tokens independently. Native engine tool activity remains inside its CLI process.

#### KV Cache effect

Cache reuse is provider-owned. The Harness adapter does not share cache state across provider routes.

## Known Limitations and Deferred Work

- Provider model catalogs are static and follow the installed SDK and Codex app-server versions.
- Native engine routes require the corresponding CLI to be installed and logged in.
- Native engine continuation persists product state under the CLI's own configuration directory.
