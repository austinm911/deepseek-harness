/**
 * LLM-seam adapter for the local engine CLIs (Claude Code, Codex). Each
 * route answers one model call by delegating the latest user text to the
 * corresponding `ctx.subagents` backend, which runs the native CLI with its
 * OAuth state — no API key — and returns the final text as one text block.
 *
 * The engines are agents, not model endpoints: they execute their own tools
 * inside their own process, so the harness sees only the final answer and
 * the session log records text-only turns. The conversation history is NOT
 * sent to the engine; each call is a fresh run of the latest user message.
 * Auxiliary calls (compaction, session titles) are refused with an error
 * finish: they would spawn a full agent run for a side task.
 *
 * @module dsh-llm-engine/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  ReasoningEffortId,
  resolveRetryPolicy,
  textOfBlocks,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { listCodexModels, type CodexModel } from '@deepseek-ai/dsh-subagent-codex'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Typed result plus the declaration merge that puts the subagent service on
// the cordis Context, so `ctx.get('subagents')` is typed at this call site.
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
// The declaration merge that puts the subprocess service on the cordis
// Context, so `ctx.get('subprocess')` is typed for codex model discovery.
import type {} from '@deepseek-ai/dsh-subprocess'

/** The engine routes this adapter serves, matching the backend provider names. */
export const ENGINE_ROUTES = ['claude-code', 'codex'] as const
/** Provider route backed by a native subscription CLI. */
export type EngineRoute = (typeof ENGINE_ROUTES)[number]

/** Model id meaning "the CLI's own configured default" (no override sent). */
export const NATIVE_MODEL = 'native'

/** One model an engine route advertises, with the metadata the harness needs. */
interface RouteModel {
  readonly id: string
  readonly name: string
  /** Capacity the compaction seam reads. */
  readonly contextWindow: number
  /** Per-request output cap, absent on a route whose engine reports none. */
  readonly maxTokens?: number
  /** Selectable efforts for this exact model. */
  readonly reasoning: LlmModelReasoningInfo
}

/**
 * Selectable efforts for every `claude-code` model, in display order. The
 * Claude Agent SDK exposes no enumeration call, so this list and the model
 * rows below are pinned to the installed SDK's families.
 */
const CLAUDE_CODE_REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off (no extended thinking)' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('xhigh'), name: 'XHigh' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

/** The models the `claude-code` route advertises, `native` last. */
const CLAUDE_CODE_MODELS: readonly RouteModel[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 64_000 },
  { id: NATIVE_MODEL, name: 'Native default', contextWindow: 1_000_000, maxTokens: 128_000 },
].map(entry => ({ ...entry, reasoning: CLAUDE_CODE_REASONING }))

/**
 * Every effort the app-server vocabulary carries, in display order. A
 * discovered model advertises the members it reports; `native` advertises all
 * of them, because the CLI's configured default model is not named here.
 */
const CODEX_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId('off'), name: 'Off (minimal)' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'XHigh' },
  { id: ReasoningEffortId('max'), name: 'Max' },
  { id: ReasoningEffortId('ultra'), name: 'Ultra' },
]

/**
 * Resolved engine-adapter options; the plugin's `Config` documents and
 * defaults every field.
 */
export interface EngineAdapterOptions {
  /** Whether turns resume the engine's long-lived session. */
  readonly continuation: boolean
  /** Whether the `codex` route queries the installed app-server for its models. */
  readonly codexModelDiscovery: boolean
  /** Deadline in milliseconds for that query. */
  readonly codexDiscoveryTimeoutMs: number
  /** Context-window tokens applied to every model the `codex` route advertises. */
  readonly codexContextWindow: number
}

/** Stable failure code for an engine turn that ended without a usable answer. */
export const ENGINE_FAILURE_CODE = 'ENGINE_FAILURE'
/** Stable failure code for auxiliary calls the engines do not serve. */
export const UNSUPPORTED_PURPOSE_CODE = 'UNSUPPORTED_PURPOSE'

/** Display names keyed by route. */
const ENGINE_NAMES: Record<EngineRoute, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/**
 * The `codex` route's override-free choice. It carries no `defaultEffort`, so
 * a caller that selects no effort keeps whatever the CLI is configured for.
 * @param contextWindow - resolved capacity for the route's models.
 * @returns the `native` route model.
 */
function codexNativeModel(contextWindow: number): RouteModel {
  return {
    id: NATIVE_MODEL,
    name: 'Native default',
    contextWindow,
    reasoning: { efforts: CODEX_EFFORTS },
  }
}

/**
 * Project one discovered app-server model onto the route. `model/list` reports
 * no capacity, so every model takes the configured context window and no
 * output cap (the adapter sends none to the CLI).
 * @param model - one model the app-server advertises.
 * @param contextWindow - resolved capacity for the route's models.
 * @returns the advertised route model.
 */
function codexRouteModel(model: CodexModel, contextWindow: number): RouteModel {
  return {
    id: model.id,
    name: model.displayName,
    contextWindow,
    reasoning: {
      efforts: CODEX_EFFORTS.filter(effort => model.efforts.includes(effort.id)),
      defaultEffort: ReasoningEffortId(model.defaultEffort),
    },
  }
}

/**
 * Resolve the actual initiating Agent so subagent lifecycle events retain the
 * parent scope and native engines inherit its session workspace.
 * @param ctx - context carrying the agent registry.
 * @returns the live Agent that initiated the model request.
 */
function parentAgent(ctx: Context): Agent {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('engine providers require the agents service')
  return agents.requireInitiator()
}

/** Longest child text carried into a failure message. */
const DETAIL_LIMIT = 500

/**
 * The child's own account of a failed run, appended to the failure message.
 * The backends report the cause as `failure` (an expired login, a refused
 * model); a provider that only produced text falls back to that text.
 * Oversized detail is cut to keep the message loggable.
 * @param result - the terminal result of the failed run.
 * @returns `": <text>"`, or `''` when the child said nothing.
 */
function failureDetail(result: SubagentResult): string {
  const text = (result.failure ?? textOfBlocks(result.output)).trim()
  if (text === '') return ''
  return `: ${text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text}`
}

/**
 * The engine-backed LLM adapter. Registers the `claude-code` and `codex`
 * routes on `ctx.llm`; each `stream()` call runs the local CLI through
 * `ctx.subagents` and translates the final answer into one text block.
 */
export class EngineLlmAdapter extends LlmAdapter {
  private readonly ctx: Context
  private readonly options: EngineAdapterOptions
  /** Per harness session and provider route: the native session id to resume. */
  private readonly sessionsById = new Map<string, Map<string, string>>()
  /** The `codex` route's catalog, queried at most once for the plugin's life. */
  private codexModels: Promise<readonly RouteModel[]> | undefined

  /**
   * @param ctx - context carrying the subagent and subprocess services at call time.
   * @param options - resolved plugin options.
   */
  constructor(ctx: Context, options: EngineAdapterOptions) {
    super()
    this.ctx = ctx
    this.options = options
    ctx.on('session/disposed', (session) => {
      this.sessionsById.delete(session.header.id)
    })
  }

  /**
   * The engine session id to resume for one harness session and provider route,
   * or `undefined` for a fresh run. Entries whose Harness session has left the
   * store are dropped so dead sessions cannot leak engine state.
   * @param provider - the engine provider route.
   * @param sessionId - the Harness session id stamped on the request.
   * @returns the recorded continuation id, if the session and route are live.
   */
  private continuationFor(provider: string, sessionId: string): string | undefined {
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined && sessions.get(SessionId(sessionId)) === undefined) {
      this.sessionsById.delete(sessionId)
      return undefined
    }
    return this.sessionsById.get(sessionId)?.get(provider)
  }

  /**
   * Ask the installed app-server what it serves. Any failure — no CLI on the
   * host, a CLI that is not logged in, a missed deadline, a reply this
   * protocol adapter does not accept — leaves the route advertising `native`
   * alone, with the cause on `ctx.logger`. No model id is ever invented, and
   * no pinned list stands in: a stale pinned list offers ids the installed CLI
   * has dropped.
   * @returns the discovered models followed by `native`, or `native` alone.
   */
  private async discoverCodexModels(): Promise<readonly RouteModel[]> {
    const native = codexNativeModel(this.options.codexContextWindow)
    if (!this.options.codexModelDiscovery) return [native]
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      this.ctx.logger.warn(
        'llm-engine: the codex route advertises only its native default — the subprocess service is not composed',
      )
      return [native]
    }
    try {
      const discovered = await listCodexModels({
        cwd: process.cwd(),
        timeoutMs: this.options.codexDiscoveryTimeoutMs,
        spawn: spec => subprocess.spawn(spec),
      })
      return [
        ...discovered.map(model => codexRouteModel(model, this.options.codexContextWindow)),
        native,
      ]
    } catch (error: unknown) {
      /* v8 ignore next -- listCodexModels rejects with Error. */
      const cause = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        'llm-engine: the codex route advertises only its native default — '
        + `codex app-server model/list failed: ${cause}`,
      )
      return [native]
    }
  }

  /**
   * The models one route advertises. `claude-code` is pinned; `codex` resolves
   * through one cached app-server query, so repeated picker reads and turn
   * admissions share a single child process for the plugin's life.
   * @param provider - the engine provider route.
   * @returns that route's advertised models.
   */
  private routeModels(provider: string): Promise<readonly RouteModel[]> {
    if (provider !== 'codex') return Promise.resolve(CLAUDE_CODE_MODELS)
    this.codexModels ??= this.discoverCodexModels()
    return this.codexModels
  }

  /** @inheritdoc */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: ENGINE_NAMES[provider as EngineRoute] }
  }

  /** @inheritdoc */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.routeModels(provider)
    return models.map(entry => ({ provider, id: entry.id, name: entry.name }))
  }

  /** @inheritdoc */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = (await this.routeModels(provider)).find(candidate => candidate.id === model)
    if (entry === undefined) {
      throw new Error(
        `engine provider ${JSON.stringify(provider)} does not serve model ${JSON.stringify(model)}`,
      )
    }
    return {
      provider,
      id: entry.id,
      name: entry.name,
      context: { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens },
      reasoning: entry.reasoning,
    }
  }

  /**
   * Engine runs must never be auto-retried: a retry would execute the CLI
   * twice. The default bounded policy would retry on transient codes, so this
   * adapter pins a zero-retry normal policy for both routes.
   * @param _provider - the engine route.
   * @returns a normal policy with `maxRetries: 0`.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'llm-engine')
  }

  /**
   * Answer one model call by running the local engine CLI on the latest user
   * text. The response is emitted as a single assembled text block followed
   * by the terminal finish; the engine's own tool activity stays inside its
   * process and is never surfaced on this stream.
   * @param options - the model call; only `provider`, `messages`, and `signal` are used.
   * @returns the stream chunks for one engine run.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: UNSUPPORTED_PURPOSE_CODE,
            message: `engine provider ${JSON.stringify(options.provider)} serves conversation turns only, not ${options.purpose} calls`,
          },
        },
      }
      return
    }
    const prompt = latestUserText(options.messages)
    if (prompt === '') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'EMPTY_PROMPT', message: 'engine providers need a non-empty user message' },
        },
      }
      return
    }
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'NO_SUBAGENTS', message: 'subagents service is not composed' },
        },
      }
      return
    }
    const sessionKey = this.options.continuation && options.sessionId !== undefined
      ? options.sessionId
      : undefined
    const continueFrom = sessionKey === undefined ? undefined : this.continuationFor(options.provider, sessionKey)
    const run = await subagents.start(options.provider, {
      prompt: [{ type: 'text', text: prompt }],
      parent: parentAgent(this.ctx),
      signal: options.signal ?? new AbortController().signal,
      ...continueFrom === undefined ? {} : { continueFrom },
      ...(options.model !== NATIVE_MODEL
        ? { agentOptions: { model: options.model } }
        : {}),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    })
    // Stream live deltas until the provider's update iterable terminates with
    // the run result. Disposal remains guaranteed if iteration or settlement
    // fails, or if the downstream consumer stops this generator.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    let sawDelta = false
    let result: Awaited<typeof run.result>
    try {
      if (run.updates !== undefined) {
        for await (const update of run.updates) {
          sawDelta = true
          yield { type: 'text-delta', index: 0, text: update.text }
        }
      }
      result = await run.result
      if (sessionKey !== undefined && result.continuationId !== undefined) {
        const routeSessions = this.sessionsById.get(sessionKey) ?? new Map<string, string>()
        routeSessions.set(options.provider, result.continuationId)
        this.sessionsById.set(sessionKey, routeSessions)
      }
    } finally {
      await run.dispose()
    }
    if (result.stopReason === 'aborted') {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { code: 'ABORTED', message: 'engine run was cancelled' },
        },
      }
      return
    }
    if (result.stopReason !== 'completed') {
      // The backend reports why the child failed; without it the caller sees a
      // bare stop reason and cannot act on an expired login or refused model.
      const detail = failureDetail(result)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: ENGINE_FAILURE_CODE,
            message: `engine ${JSON.stringify(options.provider)} finished with stopReason ${result.stopReason}${detail}`,
          },
        },
      }
      return
    }
    const text = textOfBlocks(result.output)
    if (text === '') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: EMPTY_RESPONSE_CODE,
            message: `engine ${JSON.stringify(options.provider)} returned no text`,
          },
        },
      }
      return
    }
    if (!sawDelta) yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * The text of the latest DIRECT human prompt in a conversation, or `''` when
 * there is none. The engines receive the latest instruction only; they never
 * see the conversation history. Synthetic context injections (AGENTS.md and
 * skill catalogs via `agent.inject()`, tool results) also ride user-role
 * messages with plugin/tool sources, so only `source.kind === 'user'`
 * messages qualify as instructions.
 * @param messages - the ordered conversation messages.
 * @returns the latest direct user text.
 */
function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined) continue
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const text = textOfBlocks(message.content)
    if (text !== '') return text
  }
  return ''
}
