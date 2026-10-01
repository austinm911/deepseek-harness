/**
 * LLM-seam provider plugin for the local engine CLIs. Registers the
 * `claude-code` and `codex` provider routes on `ctx.llm`: selecting one in the
 * Models picker routes the session's turns through the packaged Claude Code /
 * Codex CLI with its native OAuth login (claude.ai / ChatGPT), no API key.
 *
 * Function plugin with named exports only: the Loader discards a default
 * export's namespace, dropping this plugin's inject metadata.
 * @module @deepseek-ai/dsh-llm-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPositiveFinite } from '@deepseek-ai/dsh-subagent'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_DISPOSE_GRACE_MS,
  type CodexPermissionMode,
} from '@deepseek-ai/dsh-subagent-codex'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  type ClaudeCodePermissionMode,
} from '@deepseek-ai/dsh-subagent-claude-code'
import { ENGINE_ROUTES, EngineLlmAdapter, engineSessionsDomain, type EngineAdapterOptions } from './adapter.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-engine'

/** Services required before the routes can register. */
export const inject = ['llm', 'subprocess', 'storageDomain']

/** Default deadline for one model-discovery query. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000

/** `model/list` reports no capacity; the app-server's own catalog carries this figure. */
export const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000

/** The SDK's model list reports no capacity; current Claude models serve 1M tokens. */
export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 1_000_000

export interface Config {
  /**
   * Resume one native engine session per Harness session and route
   * (Claude `resume`, Codex `thread/resume`), so the engine keeps its own
   * history. Off: every turn is a fresh engine run on the latest message only.
   */
  continuation?: boolean
  /** Ask each route's packaged CLI for its models on the first catalog read. */
  modelDiscovery?: boolean
  /** Deadline in milliseconds for one discovery query, handshake included. */
  discoveryTimeoutMs?: number
  /** Context window assumed for every codex model; feeds compaction. */
  codexContextWindow?: number
  /** Context window assumed for every claude-code model; feeds compaction. */
  claudeContextWindow?: number
  /** Codex non-interactive permission mode for chat turns. */
  codexPermissionMode?: CodexPermissionMode
  /** Claude Code non-interactive permission mode for chat turns. */
  claudePermissionMode?: ClaudeCodePermissionMode
  /**
   * Environment forwarded to the Claude Code child. The subprocess seam strips
   * credential-shaped names, so `CLAUDE_CODE_OAUTH_TOKEN` reaches the CLI only
   * through this map. Keychain or `~/.claude` logins need nothing here.
   */
  claudeEnv?: Record<string, string>
  /** Grace in milliseconds between process-tree termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  continuation: z.boolean().default(true),
  modelDiscovery: z.boolean().default(true),
  discoveryTimeoutMs: z.number().default(DEFAULT_DISCOVERY_TIMEOUT_MS),
  codexContextWindow: z.number().default(DEFAULT_CODEX_CONTEXT_WINDOW),
  claudeContextWindow: z.number().default(DEFAULT_CLAUDE_CONTEXT_WINDOW),
  codexPermissionMode: z.union([...CODEX_PERMISSION_MODES]).default('approve-for-me'),
  claudePermissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]).default('acceptEdits'),
  claudeEnv: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/**
 * Register the engine adapter for the `claude-code` and `codex` routes.
 * Registration starts no child process; each route queries its CLI's models
 * on the first read of its catalog.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const options = config as EngineAdapterOptions
  for (const key of ['discoveryTimeoutMs', 'disposeGraceMs'] as const) {
    assertPositiveFinite('llm-engine', key, options[key])
    if (options[key] > MAX_TIMER_DELAY_MS) {
      throw new Error(`llm-engine: ${key} must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  assertPositiveFinite('llm-engine', 'codexContextWindow', options.codexContextWindow)
  assertPositiveFinite('llm-engine', 'claudeContextWindow', options.claudeContextWindow)
  const domain = await ctx.storageDomain.open(engineSessionsDomain)
  ctx.effect(() => () => domain.close(), 'llm-engine.domainClose')
  ctx.llm.registerAdapter([...ENGINE_ROUTES], new EngineLlmAdapter(ctx, options, domain.table('sessions')))
}
