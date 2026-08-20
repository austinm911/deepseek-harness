/**
 * Codex model discovery over the LLM seam. Every case answers `model/list`
 * from a scripted app-server behind the subprocess seam, so the route's
 * catalog never depends on a `codex` CLI being installed or logged in on the
 * machine running the suite.
 */

import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import * as EngineLlm from '../src/index.ts'

/** One JSON-RPC frame, as the stub reads and writes them. */
type Frame = Record<string, unknown>

/** How one scripted app-server answers a request; `undefined` never answers. */
type Answer = (method: string, id: unknown) => Frame | undefined

/** The `model/list` payload the success cases assert, verbatim from a 0.148.0 app-server. */
const MODEL_LIST_RESULT = {
  nextCursor: null,
  data: [
    {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      hidden: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' },
        { reasoningEffort: 'max' },
        { reasoningEffort: 'ultra' },
      ],
    },
    {
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      hidden: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' },
      ],
    },
    {
      id: 'gpt-5.4-internal',
      displayName: 'GPT-5.4-Internal',
      hidden: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
    },
  ],
}

/** Answer the handshake, then whatever the case scripts for `model/list`. */
function appServer(modelList: (id: unknown) => Frame | undefined): Answer {
  return (method, id) => {
    if (method === 'initialize') return { id, result: { codexHome: '/tmp/codex' } }
    if (method === 'model/list') return modelList(id)
    return undefined
  }
}

/** A stub `codex app-server --stdio` child over the subprocess seam's stdio contract. */
class StubChild {
  readonly handle: SubprocessHandle
  private readonly toChild = new PassThrough()
  private readonly fromChild = new PassThrough()
  private readonly exit = Promise.withResolvers<SubprocessOutcome>()
  private tail = ''

  constructor(answer: Answer) {
    this.toChild.on('data', (chunk: Buffer | string) => {
      this.tail += chunk.toString()
      const lines = this.tail.split('\n')
      this.tail = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const frame = JSON.parse(line) as Frame
        if (frame.id === undefined) continue
        const reply = answer(String(frame.method), frame.id)
        if (reply !== undefined) this.fromChild.write(`${JSON.stringify(reply)}\n`)
      }
    })
    const settle = (): void => { this.exit.resolve({ exitCode: 0, signal: null }) }
    this.handle = {
      pid: 4242,
      stdin: this.toChild,
      stdout: this.fromChild,
      stderr: undefined,
      collected: {},
      done: this.exit.promise,
      terminate: settle,
      waitForExit: () => { settle(); return Promise.resolve(true) },
    }
  }
}

/** A handle for a spawn that never produced a process. */
function failedSpawn(error: Error): SubprocessHandle {
  return {
    pid: -1,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    collected: {},
    done: Promise.reject(error),
    terminate: () => undefined,
    waitForExit: () => Promise.resolve(true),
  }
}

/** Mounted subprocess seam that serves one scripted child per spawn. */
class StubSubprocess extends SubprocessRuntime {
  /** Every spawn spec this service received, in order. */
  static readonly spawns: SubprocessSpawnSpec[] = []
  /** The child every spawn produces, replaced per test. */
  static child: (spec: SubprocessSpawnSpec) => SubprocessHandle = () => new StubChild(appServer(() => undefined)).handle

  /** @inheritdoc */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    StubSubprocess.spawns.push(spec)
    return StubSubprocess.child(spec)
  }

  /** @inheritdoc */
  override resolveExecutable(): Promise<string> {
    throw new Error('the discovery path resolves no executable through this seam')
  }

  /** @inheritdoc */
  override spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('the discovery path allocates no terminal')
  }
}

/**
 * Mount the LLM seam with the engine adapter over a scripted app-server.
 * @param child - the child every spawn produces; omit to mount no subprocess seam.
 * @param config - engine plugin config overrides.
 * @returns the booted context and the captured `ctx.logger.warn` messages.
 */
async function setup(
  child: ((spec: SubprocessSpawnSpec) => SubprocessHandle) | undefined,
  config: Partial<EngineLlm.Config> = {},
): Promise<{ ctx: Context; warnings: string[] }> {
  StubSubprocess.spawns.length = 0
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SubagentRuntime)
  if (child !== undefined) {
    StubSubprocess.child = child
    await ctx.plugin(StubSubprocess)
  }
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
  await ctx.plugin(EngineLlm, config)
  return { ctx, warnings }
}

/** The stub that answers `model/list` with the recorded 0.148.0 catalog. */
const servingChild = (): SubprocessHandle =>
  new StubChild(appServer(id => ({ id, result: MODEL_LIST_RESULT }))).handle

describe('codex model discovery', () => {
  it('advertises the discovered models with their own efforts and the configured capacity', async () => {
    const { ctx, warnings } = await setup(servingChild)

    const models = await ctx.llm.listModels('codex')
    // Hidden entries are withheld; `native` stays selectable, last.
    expect(models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'native'])
    expect(models.map(model => model.name)).toEqual(['GPT-5.6-Sol', 'GPT-5.5', 'Native default'])

    const sol = await ctx.llm.resolveModelInfo('codex', 'gpt-5.6-sol')
    expect(sol.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect(sol.reasoning?.defaultEffort).toBe('low')
    expect(sol.context).toEqual({ contextWindow: EngineLlm.DEFAULT_CODEX_CONTEXT_WINDOW })

    // A narrower model advertises only what it reported.
    const gpt55 = await ctx.llm.resolveModelInfo('codex', 'gpt-5.5')
    expect(gpt55.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(gpt55.reasoning?.defaultEffort).toBe('medium')

    // The CLI-default choice keeps the whole vocabulary and no harness default.
    const native = await ctx.llm.resolveModelInfo('codex', 'native')
    expect(native.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect(native.reasoning?.defaultEffort).toBeUndefined()

    expect(warnings).toEqual([])
    await ctx.fiber.dispose()
  })

  it('spawns the app-server once for repeated catalog reads', async () => {
    const { ctx } = await setup(servingChild)

    await Promise.all([ctx.llm.listModels('codex'), ctx.llm.listModels('codex')])
    await ctx.llm.resolveModelInfo('codex', 'gpt-5.5')

    expect(StubSubprocess.spawns).toHaveLength(1)
    expect(StubSubprocess.spawns[0]!.argv).toContain('app-server')
    await ctx.fiber.dispose()
  })

  it('starts no child process for the claude-code route', async () => {
    const { ctx } = await setup(servingChild)
    await ctx.llm.listModels('claude-code')
    expect(StubSubprocess.spawns).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('rejects an effort the discovered model does not support', async () => {
    const { ctx } = await setup(servingChild)

    await expect(ctx.llm.resolveCallConfig({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'ultra' as never,
    })).rejects.toThrow(/does not support reasoning effort "ultra"/)

    // The same effort on a model that reported it resolves.
    const resolved = await ctx.llm.resolveCallConfig({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra' as never,
    })
    expect(resolved.reasoningEffort).toBe('ultra')
    await ctx.fiber.dispose()
  })

  it('rejects a model the app-server no longer serves', async () => {
    const { ctx } = await setup(servingChild)
    await expect(ctx.llm.resolveModelInfo('codex', 'gpt-5.3-codex')).rejects.toThrow(
      /does not serve model "gpt-5\.3-codex"/,
    )
    await ctx.fiber.dispose()
  })

  for (const scenario of [
    {
      name: 'a CLI that never answers',
      config: { codexDiscoveryTimeoutMs: 50 },
      child: () => new StubChild(appServer(() => undefined)).handle,
      cause: /did not answer within 50ms/,
    },
    {
      name: 'a CLI that is not installed',
      config: {},
      child: () => failedSpawn(new Error('spawn codex ENOENT')),
      cause: /spawn codex ENOENT/,
    },
    {
      name: 'a CLI that is not logged in',
      config: {},
      child: () => new StubChild(appServer(id => ({
        id,
        error: { code: -32_000, message: 'Not logged in. Run codex login.' },
      }))).handle,
      cause: /Not logged in/,
    },
    {
      name: 'a malformed reply',
      config: {},
      child: () => new StubChild(appServer(id => ({ id, result: { data: 'not a list' } }))).handle,
      cause: /invalid model\/list data/,
    },
    {
      name: 'an effort vocabulary this adapter cannot send',
      config: {},
      child: () => new StubChild(appServer(id => ({
        id,
        result: {
          data: [{
            id: 'gpt-6',
            displayName: 'GPT-6',
            hidden: false,
            defaultReasoningEffort: 'hyper',
            supportedReasoningEfforts: [{ reasoningEffort: 'hyper' }],
          }],
        },
      }))).handle,
      cause: /unsupported reasoning effort "hyper"/,
    },
  ]) {
    it(`degrades to the native default for ${scenario.name}`, async () => {
      const { ctx, warnings } = await setup(scenario.child, scenario.config)

      const models = await ctx.llm.listModels('codex')
      expect(models.map(model => model.id)).toEqual(['native'])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/advertises only its native default/)
      expect(warnings[0]).toMatch(scenario.cause)
      await ctx.fiber.dispose()
    })
  }

  it('degrades to the native default without a composed subprocess service', async () => {
    const { ctx, warnings } = await setup(undefined)
    const models = await ctx.llm.listModels('codex')
    expect(models.map(model => model.id)).toEqual(['native'])
    expect(warnings[0]).toMatch(/the subprocess service is not composed/)
    await ctx.fiber.dispose()
  })

  it('advertises the native default alone with discovery disabled, starting no child', async () => {
    const { ctx, warnings } = await setup(servingChild, { codexModelDiscovery: false })
    const models = await ctx.llm.listModels('codex')
    expect(models.map(model => model.id)).toEqual(['native'])
    expect(StubSubprocess.spawns).toHaveLength(0)
    expect(warnings).toEqual([])
    await ctx.fiber.dispose()
  })

  for (const field of ['codexDiscoveryTimeoutMs', 'codexContextWindow'] as const) {
    it(`refuses a non-positive ${field} at load`, async () => {
      const ctx = new Context()
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SubagentRuntime)
      await expect(ctx.plugin(EngineLlm, { [field]: 0 })).rejects.toThrow(
        `llm-engine: ${field} must be a positive finite number`,
      )
      await ctx.fiber.dispose()
    })
  }

  it('refuses a discovery timeout Node cannot schedule', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(EngineLlm, { codexDiscoveryTimeoutMs: 2_147_483_648 })).rejects.toThrow(
      /codexDiscoveryTimeoutMs must be no greater than/,
    )
    await ctx.fiber.dispose()
  })
})
