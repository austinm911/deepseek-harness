/**
 * LLM-seam adapter for the local engine CLIs (Claude Code, Codex). Each route
 * answers one model call by running the native CLI with its own OAuth state
 * (no API key) on the latest user text, streaming its answer as one text block.
 *
 * The engines are agents, not model endpoints: they execute their own tools in
 * their own process, so the harness records text-only turns. History is not
 * sent; with `continuation` on, each Harness session resumes one native engine
 * session per route, so the engine keeps its own history instead. Auxiliary
 * calls (compaction, session titles) are refused: they would spawn a full
 * agent run for a side task.
 *
 * The backends are called directly rather than through `ctx.subagents`: a
 * model call has no parent Agent to delegate from, and a chat turn is not a
 * delegation the subagent catalog should record.
 *
 * @module @deepseek-ai/dsh-llm-engine/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  listCodexModels,
  startCodexRun,
  type CodexModelInfo,
  type CodexPermissionMode,
} from '@deepseek-ai/dsh-subagent-codex'
import {
  listClaudeCodeModels,
  startClaudeCodeRun,
  type ClaudeCodeModelInfo,
  type ClaudeCodePermissionMode,
} from '@deepseek-ai/dsh-subagent-claude-code'

/** The engine routes this adapter serves. */
export const ENGINE_ROUTES = ['claude-code', 'codex'] as const
/** Provider route backed by a native subscription CLI. */
export type EngineRoute = (typeof ENGINE_ROUTES)[number]

/** Model id meaning "the CLI's own configured default" (no override sent). */
export const NATIVE_MODEL = 'native'

/** Stable failure code for an engine turn that ended without a usable answer. */
export const ENGINE_FAILURE_CODE = 'ENGINE_FAILURE'
/** Stable failure code for auxiliary calls the engines do not serve. */
export const UNSUPPORTED_PURPOSE_CODE = 'UNSUPPORTED_PURPOSE'

/** Resolved adapter options; the plugin's `Config` documents and defaults every field. */
export interface EngineAdapterOptions {
  readonly continuation: boolean
  readonly modelDiscovery: boolean
  readonly discoveryTimeoutMs: number
  readonly codexContextWindow: number
  readonly claudeContextWindow: number
  readonly codexPermissionMode: CodexPermissionMode
  readonly claudePermissionMode: ClaudeCodePermissionMode
  readonly claudeEnv: Record<string, string>
  readonly disposeGraceMs: number
}

/** One model a route advertises, with the metadata the harness needs. */
interface RouteModel {
  readonly id: string
  readonly name: string
  readonly reasoning: LlmModelReasoningInfo
}

const ENGINE_NAMES: Record<EngineRoute, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/**
 * Harness effort ids in display order, per route. The harness `off` is
 * Codex's `minimal` and Claude's disabled thinking; every other id is sent
 * as-is. `native` and unlisted models offer the whole route vocabulary.
 */
const ROUTE_EFFORTS: Record<EngineRoute, readonly LlmReasoningEffortInfo[]> = {
  codex: [
    { id: ReasoningEffortId('off'), name: 'Off (minimal)' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('xhigh'), name: 'XHigh' },
    { id: ReasoningEffortId('max'), name: 'Max' },
    { id: ReasoningEffortId('ultra'), name: 'Ultra' },
  ],
  'claude-code': [
    { id: ReasoningEffortId('off'), name: 'Off (no extended thinking)' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('xhigh'), name: 'XHigh' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
}

const fromCodexWireEffort = (effort: string): string => (effort === 'minimal' ? 'off' : effort)

function codexRouteModel(model: CodexModelInfo): RouteModel {
  const reported = new Set(model.efforts.map(fromCodexWireEffort))
  return {
    id: model.id,
    name: model.displayName,
    reasoning: {
      efforts: ROUTE_EFFORTS.codex.filter(effort => reported.has(effort.id)),
      ...model.defaultEffort === undefined
        ? {}
        : { defaultEffort: ReasoningEffortId(fromCodexWireEffort(model.defaultEffort)) },
    },
  }
}

/** Claude can always disable thinking, so `off` is offered beside the reported levels. */
function claudeRouteModel(model: ClaudeCodeModelInfo): RouteModel {
  const reported = new Set(['off', ...model.efforts])
  return {
    id: model.id,
    name: model.displayName,
    reasoning: { efforts: ROUTE_EFFORTS['claude-code'].filter(effort => reported.has(effort.id)) },
  }
}

/** Every text block's text, in order; `''` when there is none. */
function textOfBlocks(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Longest engine diagnostic carried into a failure message. */
const DETAIL_LIMIT = 500

function failureDetail(result: SubagentResult): string {
  const text = (result.diagnostic ?? textOfBlocks(result.output)).trim()
  if (text === '') return ''
  return `: ${text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text}`
}

function errorFinish(code: string, message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/**
 * Single-consumer queue bridging the backend's `onTextDelta` callback to the
 * stream generator. `end()` releases a waiting consumer once the run settles.
 */
class DeltaQueue {
  private readonly items: string[] = []
  private ended = false
  private wake: (() => void) | undefined

  push(text: string): void {
    if (this.ended || text === '') return
    this.items.push(text)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *drain(): AsyncGenerator<string> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/**
 * The latest direct human prompt. Context injections (AGENTS.md, skill
 * catalogs, tool results) also ride user-role messages but carry a non-user
 * source, so they never count as the instruction.
 */
function latestUserText(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || message.role !== 'user') continue
    if (message.source !== undefined && message.source.kind !== 'user') continue
    const text = textOfBlocks(message.content)
    if (text !== '') return text
  }
  return ''
}

const nativeSessionIds = z.object({
  codex: z.string().optional(),
  'claude-code': z.string().optional(),
})

/** Native session/thread ids one Harness session has accumulated, per route. */
export type NativeSessionIds = z.infer<typeof nativeSessionIds>

/**
 * Durable Harness session id → native engine session ids. Persisting them lets
 * a session reopened after an app restart resume the same Claude/Codex
 * conversation. Records are disposable: a bad one is set aside, and the next
 * turn simply starts a fresh native session.
 */
export const engineSessionsDomain = defineDomain({
  name: 'llm_engine_sessions',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<string, NativeSessionIds>(nativeSessionIds),
  },
})

/** Registers the `claude-code` and `codex` routes and runs each turn on the local CLI. */
export class EngineLlmAdapter extends LlmAdapter {
  /** Each route's catalog, discovered at most once per plugin life. */
  private readonly catalogs = new Map<EngineRoute, Promise<readonly RouteModel[]>>()

  constructor(
    private readonly ctx: Context,
    private readonly options: EngineAdapterOptions,
    /** Harness session id → native ids to resume; written after every turn that reports one. */
    private readonly sessions: Pick<KvTable<string, NativeSessionIds>, 'get' | 'put'>,
  ) {
    super()
  }

  private routeFallback(route: EngineRoute, id: string, name: string): RouteModel {
    return { id, name, reasoning: { efforts: ROUTE_EFFORTS[route] } }
  }

  /**
   * Ask the route's packaged CLI what it serves, once per plugin life. Any
   * failure (not logged in, deadline, malformed reply) leaves `native` alone
   * and logs the cause; no pinned list stands in for the CLI's real catalog.
   */
  private async discoverModels(route: EngineRoute): Promise<readonly RouteModel[]> {
    const native = this.routeFallback(route, NATIVE_MODEL, 'Native default')
    if (!this.options.modelDiscovery) return [native]
    const spec = {
      cwd: process.cwd(),
      timeoutMs: this.options.discoveryTimeoutMs,
      spawn: this.ctx.subprocess.spawn.bind(this.ctx.subprocess),
    }
    try {
      const discovered = route === 'codex'
        ? (await listCodexModels({ ...spec, env: {} })).map(codexRouteModel)
        : (await listClaudeCodeModels({ ...spec, env: this.options.claudeEnv })).map(claudeRouteModel)
      return [native, ...discovered]
    } catch (error: unknown) {
      const cause = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`llm-engine: ${route} route offers only its native default; model discovery failed: ${cause}`)
      return [native]
    }
  }

  private routeModels(provider: string): Promise<readonly RouteModel[]> {
    const route = provider as EngineRoute
    let models = this.catalogs.get(route)
    if (models === undefined) {
      models = this.discoverModels(route)
      this.catalogs.set(route, models)
    }
    return models
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: ENGINE_NAMES[provider as EngineRoute] }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.routeModels(provider)).map(entry => ({ provider, id: entry.id, name: entry.name }))
  }

  /**
   * An id missing from the catalog (discovery failed, or a session saved a
   * model the list no longer names) still resolves: the CLI is the authority
   * on what it serves and reports a refused model as an engine failure.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = provider as EngineRoute
    const entry = (await this.routeModels(route)).find(candidate => candidate.id === model)
      ?? this.routeFallback(route, model, model)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      context: {
        contextWindow: route === 'codex' ? this.options.codexContextWindow : this.options.claudeContextWindow,
      },
      reasoning: entry.reasoning,
    }
  }

  /** A retry would run the agent turn twice, so engine routes never retry. */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'llm-engine')
  }

  /** Workspace of the Agent whose turn issued this model call. */
  private workspace(): string | undefined {
    return this.ctx.get('agents')?.currentInitiator()?.session.header.cwd
  }

  private startRun(
    route: EngineRoute,
    prompt: string,
    options: GenerateOptions,
    cwd: string,
    resume: string | undefined,
    deltas: DeltaQueue,
    onNativeId: (id: string) => void,
  ): Promise<SubagentRun> {
    const request = {
      prompt: [{ type: 'text' as const, text: prompt }],
      signal: options.signal ?? new AbortController().signal,
    }
    const model = options.model === NATIVE_MODEL ? {} : { model: options.model }
    const common = {
      cwd,
      ...model,
      disposeGraceMs: this.options.disposeGraceMs,
      spawn: this.ctx.subprocess.spawn.bind(this.ctx.subprocess),
      onError: (error: Error) => {
        this.ctx.logger.warn(`llm-engine ${route}: ${error.message}`)
      },
      onTextDelta: (text: string) => { deltas.push(text) },
    }
    if (route === 'codex') {
      return startCodexRun(request, {
        ...common,
        env: {},
        permissionMode: this.options.codexPermissionMode,
        persistThread: this.options.continuation,
        ...resume === undefined ? {} : { resumeThreadId: resume },
        ...options.reasoningEffort === undefined
          ? {}
          : { effort: options.reasoningEffort === 'off' ? 'minimal' : options.reasoningEffort },
        onThreadId: onNativeId,
      })
    }
    return startClaudeCodeRun(request, {
      ...common,
      env: this.options.claudeEnv,
      permissionMode: this.options.claudePermissionMode,
      persistSession: this.options.continuation,
      ...resume === undefined ? {} : { resumeSessionId: resume },
      ...options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort },
      onSessionId: onNativeId,
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = options.provider as EngineRoute
    if (options.purpose !== undefined) {
      yield errorFinish(
        UNSUPPORTED_PURPOSE_CODE,
        `engine provider ${JSON.stringify(route)} serves conversation turns only, not ${options.purpose} calls`,
      )
      return
    }
    const prompt = latestUserText(options.messages)
    if (prompt === '') {
      yield errorFinish('EMPTY_PROMPT', 'engine providers need a non-empty user message')
      return
    }
    const cwd = this.workspace()
    if (cwd === undefined) {
      yield errorFinish('NO_WORKSPACE', 'engine providers need a session with a working directory')
      return
    }
    const sessionKey = this.options.continuation ? options.sessionId : undefined
    const resume = sessionKey === undefined ? undefined : this.sessions.get(sessionKey)?.[route]
    let nativeId: string | undefined
    const deltas = new DeltaQueue()

    let run: SubagentRun
    try {
      run = await this.startRun(route, prompt, options, cwd, resume, deltas, (id) => { nativeId = id })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield errorFinish(ENGINE_FAILURE_CODE, `engine ${JSON.stringify(route)} failed to start: ${message}${await this.forgetResume(sessionKey, route, resume)}`)
      return
    }

    let result: SubagentResult
    try {
      const settled = run.result.finally(() => { deltas.end() })
      // A rejected result also ends the queue; observe it here so the rejection
      // surfaces from the await below, not as an unhandled rejection.
      settled.catch(() => undefined)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for await (const text of deltas.drain()) yield { type: 'text-delta', index: 0, text }
      result = await settled
    } finally {
      await run.dispose()
    }

    if (sessionKey !== undefined && nativeId !== undefined && nativeId !== resume) {
      await this.sessions.put(sessionKey, { ...this.sessions.get(sessionKey), [route]: nativeId })
    }
    if (result.stopReason === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'engine run was cancelled' } } }
      return
    }
    if (result.stopReason !== 'completed') {
      yield errorFinish(
        ENGINE_FAILURE_CODE,
        `engine ${JSON.stringify(route)} finished with ${result.stopReason}${failureDetail(result)}${await this.forgetResume(sessionKey, route, resume)}`,
      )
      return
    }
    const text = textOfBlocks(result.output)
    if (text === '') {
      yield errorFinish(EMPTY_RESPONSE_CODE, `engine ${JSON.stringify(route)} returned no text`)
      return
    }
    // Live deltas are a preview; the block-end text is the engine's final answer.
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * A failed resumed turn drops the route's stored id. The native conversation
   * may be gone (Claude Code prunes old transcripts, a Codex thread can be
   * archived), and retrying a dead id would fail every later turn in the
   * session. Cancellation never reaches here, so it keeps the id.
   * @returns a message suffix naming the reset, or `''` when nothing was stored.
   */
  private async forgetResume(sessionKey: string | undefined, route: EngineRoute, resume: string | undefined): Promise<string> {
    if (sessionKey === undefined || resume === undefined) return ''
    const { [route]: _dropped, ...rest } = this.sessions.get(sessionKey) ?? {}
    await this.sessions.put(sessionKey, rest)
    return `; the next message starts a new ${ENGINE_NAMES[route]} conversation`
  }
}
