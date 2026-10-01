/**
 * Claude Code model discovery: ask the logged-in CLI which models it offers
 * through one short-lived official SDK query that never sends a turn.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/models
 */

import {
  query as officialQuery,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import {
  claudeQueryOptions,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeClaudeCodeChild,
} from './run.ts'

/** One model the logged-in Claude Code CLI offers. */
export interface ClaudeCodeModelInfo {
  /** Value to send as SDK `model` (ModelInfo.value). */
  readonly id: string
  readonly displayName: string
  /** SDK effort levels the model accepts (ModelInfo.supportedEffortLevels when supportsEffort, else []). */
  readonly efforts: readonly string[]
}

/** Inputs for one model-discovery query. */
export interface ClaudeCodeModelListSpec {
  readonly cwd: string
  readonly timeoutMs: number
  readonly env: Record<string, string>
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

const TIMEOUT_CODE = 'CLAUDE_CODE_MODEL_LIST_TIMEOUT'

/** Bounded stderr tail kept off the host's stderr; a pipe would need draining. */
const STDERR_TAIL = { maxBytes: 16 * 1024 } as const

/** The ModelInfo fields this module reads; the reply crosses an IPC boundary. */
const SUPPORTED_MODELS_REPLY = z.array(z.object({
  value: z.string().min(1),
  displayName: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
}))

/**
 * List the models the logged-in Claude Code CLI offers.
 *
 * One short-lived SDK query in streaming-input mode whose prompt iterable never
 * yields a message: await `supportedModels()`, then close the query and wait for
 * the child tree to exit through the shared subprocess service. No turn is ever
 * sent. Rows whose `value` is 'default' are dropped (llm-engine offers its own
 * `native`). Child stderr is collected, never forwarded to host stderr.
 * @param spec - workspace, deadline, explicit environment, and subprocess spawn.
 * @returns the CLI's models in reply order.
 * @throws on timeout, process failure, malformed reply, or teardown failure.
 */
export async function listClaudeCodeModels(
  spec: ClaudeCodeModelListSpec,
): Promise<readonly ClaudeCodeModelInfo[]> {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-claude-code: timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }

  let releasePrompt!: () => void
  const promptReleased = new Promise<void>((resolve) => { releasePrompt = resolve })
  // Streaming-input mode keeps the control channel open; ending only on
  // release means the CLI never receives a user turn.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await promptReleased
        return { done: true, value: undefined }
      },
    }),
  }

  const controller = new AbortController()
  let child: SubprocessHandle | undefined
  let query: Query | undefined
  let result: readonly ClaudeCodeModelInfo[] | undefined
  let failure: Error | undefined
  using timer = deadline(undefined, spec.timeoutMs, TIMEOUT_CODE)
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(
        {
          cwd: spec.cwd,
          env: spec.env,
          permissionMode: 'dontAsk',
          disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
          spawn: (spawnSpec) => spec.spawn({
            ...spawnSpec,
            stdio: { ...spawnSpec.stdio, stderr: STDERR_TAIL },
          }),
        },
        controller,
        (captured) => { child = captured },
        () => {},
      ),
    })
    const published = child
    if (published === undefined) {
      throw new Error('subagent-claude-code: official SDK did not publish a controllable Claude Code process')
    }
    const exited = published.done.then(
      (outcome) => {
        throw new Error(
          `subagent-claude-code: Claude Code exited before listing models (exit code: ${outcome.exitCode}; signal: ${outcome.signal})`,
        )
      },
      (error: unknown) => {
        throw new Error('subagent-claude-code: Claude Code process failed while listing models', { cause: error })
      },
    )
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer.signal.addEventListener('abort', () => {
        reject(new Error(`subagent-claude-code: listing models timed out after ${spec.timeoutMs}ms`))
      }, { once: true })
    })
    const reply = query.supportedModels()
    // Losers of the race settle after teardown; keep them handled.
    for (const loser of [exited, timedOut, reply]) void loser.catch(() => {})
    const parsed = SUPPORTED_MODELS_REPLY.safeParse(await Promise.race([reply, exited, timedOut]))
    if (!parsed.success) {
      throw new Error('subagent-claude-code: malformed supportedModels reply', { cause: parsed.error })
    }
    result = parsed.data
      // llm-engine offers its own `native` entry for the CLI's default model.
      .filter((row) => row.value !== 'default')
      .map((row) => ({
        id: row.value,
        displayName: row.displayName,
        efforts: row.supportsEffort === true ? row.supportedEffortLevels ?? [] : [],
      }))
  } catch (error: unknown) {
    failure = error instanceof Error ? error : new Error(String(error))
  }

  releasePrompt()
  try {
    if (child !== undefined) await disposeClaudeCodeChild(query, child)
    else query?.close()
  } catch (disposeError: unknown) {
    const cleanup = disposeError instanceof Error ? disposeError : new Error(String(disposeError))
    throw failure === undefined
      ? cleanup
      : new AggregateError([failure, cleanup], `${failure.message}; ${cleanup.message}`)
  } finally {
    controller.abort()
  }
  if (failure !== undefined) throw failure
  return result!
}
