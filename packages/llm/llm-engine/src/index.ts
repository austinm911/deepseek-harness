/**
 * LLM-seam provider plugin for the local engine CLIs. Registers the
 * `claude-code` and `codex` provider routes on `ctx.llm`, backed by the
 * matching `ctx.subagents` backends: selecting one of these providers in the
 * web Models picker (or any model selection) routes the session's turns
 * through the local Claude Code / Codex CLI with its native OAuth state — no
 * API key. The adapter answers each turn with the engine's final text; the
 * engines execute their own tools inside their own process.
 *
 * Function plugin with named exports only: the Loader discards a default
 * export's namespace, dropping this plugin's inject metadata
 * (docs/postmortem/0001).
 * @module @deepseek-ai/dsh-llm-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertPositiveFinite } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ENGINE_ROUTES, EngineLlmAdapter, type EngineAdapterOptions } from './adapter.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-engine'

/** Services required before the routes can register. */
export const inject = ['llm', 'subagents']

/** Default deadline for one `codex app-server` `model/list` query. */
export const DEFAULT_CODEX_DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Default context-window tokens for the `codex` route. `model/list` reports no
 * capacity, and the app-server's own model catalog carries this figure for
 * every model it serves.
 */
export const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000

/** Plugin config: the session switch and the `codex` route's discovery inputs. */
export interface Config {
  /**
   * Whether turns resume the engine's long-lived session (Claude `resume`,
   * Codex `thread/resume`) instead of starting fresh. Requires the
   * `continuation: true` option on the matching backend rows; engine state
   * then persists under the native CLI config dirs.
   */
  continuation?: boolean
  /**
   * Whether the `codex` route asks the installed `codex app-server` which
   * models it serves, on the first read of the route's catalog. With
   * discovery off — an offline host, or a composition that must advertise the
   * same route on every machine — the route advertises only `native`.
   */
  codexModelDiscovery?: boolean
  /**
   * Deadline in milliseconds for that query, covering the app-server
   * handshake and the `model/list` reply together.
   */
  codexDiscoveryTimeoutMs?: number
  /**
   * Context-window tokens the harness assumes for every model the `codex`
   * route advertises, `native` included. The app-server reports no capacity,
   * and this figure feeds compaction.
   */
  codexContextWindow?: number
}

/** @inheritdoc */
export const Config: z<Config> = z.object({
  continuation: z.boolean().default(false),
  codexModelDiscovery: z.boolean().default(true),
  codexDiscoveryTimeoutMs: z.number().default(DEFAULT_CODEX_DISCOVERY_TIMEOUT_MS),
  codexContextWindow: z.number().default(DEFAULT_CODEX_CONTEXT_WINDOW),
})

/**
 * Register the engine adapter for the `claude-code` and `codex` routes. The
 * registration is a fiber-owned effect: unloading the plugin withdraws the
 * routes. Registration starts no child process; the `codex` route queries the
 * app-server on the first read of its catalog.
 * @param ctx - context carrying the LLM runtime and the subagent service.
 * @param config - session switch and `codex` discovery inputs.
 */
export function apply(ctx: Context, config: Config): void {
  const options = config as EngineAdapterOptions
  assertPositiveFinite('llm-engine', 'codexDiscoveryTimeoutMs', options.codexDiscoveryTimeoutMs)
  if (options.codexDiscoveryTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-engine: codexDiscoveryTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveFinite('llm-engine', 'codexContextWindow', options.codexContextWindow)
  ctx.llm.registerAdapter([...ENGINE_ROUTES], new EngineLlmAdapter(ctx, options))
}
