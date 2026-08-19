/**
 * Engine adapter unit coverage: mount the real LLM runtime and subagent
 * runtime, register a controllable stub provider per engine route, and pin
 * the stream chunk grammar, the no-retry policy, and the refusal surfaces
 * (empty prompt, auxiliary purposes, error/aborted results) without ever
 * starting a product process.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRun, SubagentStartRequest, SubagentUpdate } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as EngineLlm from '../src/index.ts'

/** Controllable fake provider: records calls, serves scripted results. */
class FakeProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
    continuation: true,
    reasoningEffort: true,
  }
  readonly inheritsParentContext = false
  calls: SubagentStartRequest[] = []
  result: SubagentResultFixture | undefined
  updates: SubagentUpdate[] | undefined
  continuationId: string | undefined
  disposed = false

  constructor(name: string) {
    this.name = name
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.calls.push(request)
    const fixture = this.result
    if (fixture === undefined) throw new Error(`FakeProvider ${this.name} has no scripted result`)
    const result = Promise.resolve({
      stopReason: fixture.stopReason,
      output: fixture.output,
      ...this.continuationId === undefined ? {} : { continuationId: this.continuationId },
    })
    return {
      id: SessionId(`run-${this.calls.length}`),
      localAgent: undefined,
      result,
      ...this.updates === undefined ? {} : {
        updates: {
          [Symbol.asyncIterator]: async function* (this: FakeProvider) {
            for (const update of this.updates ?? []) yield update
          }.bind(this),
        },
      },
      dispose: async () => {
        this.disposed = true
      },
  }
}
}

interface SubagentResultFixture {
  stopReason: 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal'
  output: ContentBlock[]
}

const PONG: ContentBlock[] = [{ type: 'text', text: 'PONG' }]

/** The `failure` half of an expected finish reason, typed as LlmFailure. */
/** Minimal real Agent used to establish the initiating-agent lifecycle context. */
function testAgent(rawId = 'engine-parent'): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}
function failureWith(code: string): { code: string; message?: string } {
  return expect.objectContaining({ code }) as { code: string; message?: string }
}

async function setup(
  provider: FakeProvider,
  continuation = false,
  additionalProviders: readonly FakeProvider[] = [],
): Promise<{
  ctx: Context
  collect: (sessionId?: string, providerName?: string) => Promise<StreamChunk[]>
  withParent: <T>(operation: () => T) => T
}> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SubagentRuntime)
  for (const candidate of [provider, ...additionalProviders]) {
    ctx.subagents.registerProvider(candidate)
  }
  await ctx.plugin(EngineLlm, continuation ? { continuation: true } : {})
  const parent = testAgent()
  const collect = async (sessionId?: string, providerName = provider.name): Promise<StreamChunk[]> =>
    ctx.agents.withInitiator(parent, async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: providerName,
        model: 'native',
        messages: [userMessage('PONG')],
        ...sessionId === undefined ? {} : { sessionId: SessionId(sessionId) },
      })) chunks.push(chunk)
      return chunks
    })
  return {
    ctx,
    collect,
    withParent: <T>(operation: () => T): T => ctx.agents.withInitiator(parent, operation),
  }
}
/** A complete user message through the shared factory (the runtime reads `source` before dispatch). */
function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** A complete assistant message through the shared factory. */
function assistantMessage(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'probe', model: 'probe' },
  })
}

describe('engine LLM adapter', () => {
  for (const engine of ['claude-code', 'codex'] as const) {
    it(`registers ${engine} with the native model and a zero-retry policy`, async () => {
      const fake = new FakeProvider(engine)
      const { ctx } = await setup(fake)
      const providers = ctx.llm.listProviders()
      expect(providers.some(info => info.id === engine)).toBe(true)
      const models = await ctx.llm.listModels(engine)
      const ids = models.map(model => model.id)
      // The real catalog, plus the native (CLI default) choice.
      expect(ids).toContain('native')
      expect(ids.length).toBeGreaterThan(1)
      const policy = ctx.llm.providerRetryPolicy(engine)
      expect(policy.mode).toBe('normal')
      if (policy.mode === 'normal') expect(policy.maxRetries).toBe(0)
      await ctx.fiber.dispose()
    })

    it(`emits one text block with a stop finish for a completed ${engine} run`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'completed', output: PONG }
      const { ctx, collect } = await setup(fake)
      const chunks = await collect()
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'PONG' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'PONG' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      expect(fake.calls).toHaveLength(1)
      // The engine receives exactly the latest user text.
      const prompt = fake.calls[0]!.prompt
      expect(prompt).toEqual([{ type: 'text', text: 'PONG' }])
      await ctx.fiber.dispose()
    })

    it(`maps a non-completed ${engine} result to an error finish`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'error', output: [] }
      const { ctx, collect } = await setup(fake)
      const chunks = await collect()
      // The text block opened for live streaming stays open; the seam allows
      // an error finish to leave content blocks open (consumers discard).
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'finish', reason: { kind: 'error', failure: failureWith('ENGINE_FAILURE') } },
      ])
      await ctx.fiber.dispose()
    })

    it(`maps an aborted ${engine} result to an aborted finish`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'aborted', output: [] }
      const { ctx, collect } = await setup(fake)
      const chunks = await collect()
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'finish', reason: { kind: 'aborted', failure: failureWith('ABORTED') } },
      ])
      await ctx.fiber.dispose()
    })

    it(`refuses an empty prompt for ${engine} without starting the engine`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'completed', output: PONG }
      const { ctx, withParent } = await setup(fake)
      const chunks = await withParent(async () => {
        const collected: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream({
          provider: engine,
          model: 'native',
          messages: [assistantMessage('PONG')],
        })) collected.push(chunk)
        return collected
      })
      expect(chunks).toEqual([{
        type: 'finish',
        reason: { kind: 'error', failure: failureWith('EMPTY_PROMPT') },
      }])
      expect(fake.calls).toHaveLength(0)
      await ctx.fiber.dispose()
    })

    it(`streams live text deltas for ${engine} while the run settles`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'completed', output: PONG }
      fake.updates = [{ kind: 'text-delta', text: 'Hel' }, { kind: 'text-delta', text: 'lo' }]
      const { ctx, collect } = await setup(fake)
      const chunks = await collect()
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Hel' },
        { type: 'text-delta', index: 0, text: 'lo' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'PONG' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      expect(fake.disposed).toBe(true)
      await ctx.fiber.dispose()
    })


    it(`refuses auxiliary purposes for ${engine} without starting the engine`, async () => {
      const fake = new FakeProvider(engine)
      fake.result = { stopReason: 'completed', output: PONG }
      const { ctx, withParent } = await setup(fake)
      const chunks = await withParent(async () => {
        const collected: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream({
          provider: engine,
          model: 'native',
          purpose: 'session-title',
          messages: [userMessage('title me')],
        })) collected.push(chunk)
        return collected
      })
      expect(chunks).toEqual([{
        type: 'finish',
        reason: { kind: 'error', failure: failureWith('UNSUPPORTED_PURPOSE') },
      }])
      expect(fake.calls).toHaveLength(0)
      await ctx.fiber.dispose()
    })
  }
})

describe('engine LLM adapter model and effort selection', () => {
  it('advertises the real model catalog with reasoning efforts per engine', async () => {
    for (const engine of ['claude-code', 'codex'] as const) {
      const fake = new FakeProvider(engine)
      const { ctx } = await setup(fake)
      const models = await ctx.llm.listModels(engine)
      expect(models.length).toBeGreaterThan(1)
      const resolved = await ctx.llm.resolveModelInfo(engine, models[0]!.id)
      expect(resolved.reasoning?.efforts.length).toBeGreaterThan(1)
      expect(resolved.context).toBeDefined()
      await ctx.fiber.dispose()
    }
  })

  it('passes the selected model and effort to the engine run', async () => {
    const fake = new FakeProvider('claude-code')
    fake.result = { stopReason: 'completed', output: PONG }
    const { ctx, withParent } = await setup(fake)
    const chunks = await withParent(async () => {
      const collected: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'claude-code',
        model: 'claude-opus-5',
        reasoningEffort: 'max' as never,
        messages: [userMessage('PONG')],
      })) collected.push(chunk)
      return collected
    })
    expect(chunks.filter(c => c.type === 'finish').length).toBe(1)
    expect(fake.calls[0]!.agentOptions?.model).toBe('claude-opus-5')
    expect(fake.calls[0]!.reasoningEffort).toBe('max')
    await ctx.fiber.dispose()
  })

  it('omits the model override for the native choice', async () => {
    const fake = new FakeProvider('codex')
    fake.result = { stopReason: 'completed', output: PONG }
    const { ctx, collect } = await setup(fake)
    await collect()
    expect(fake.calls[0]!.agentOptions).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('engine LLM adapter continuation', () => {
  it('resumes the engine session across turns of one harness session', async () => {
    const fake = new FakeProvider('claude-code')
    fake.result = { stopReason: 'completed', output: PONG }
    fake.continuationId = 'engine-session-1'
    const { ctx, collect } = await setup(fake, true)

    await collect('harness-session-a')
    expect(fake.calls[0]!.continueFrom).toBeUndefined()

    await collect('harness-session-a')
    expect(fake.calls[1]!.continueFrom).toBe('engine-session-1')

    // A different harness session starts fresh.
    await collect('harness-session-b')
    expect(fake.calls[2]!.continueFrom).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps native continuation ids isolated by provider route', async () => {
    const claude = new FakeProvider('claude-code')
    claude.result = { stopReason: 'completed', output: PONG }
    claude.continuationId = 'claude-session'
    const codex = new FakeProvider('codex')
    codex.result = { stopReason: 'completed', output: PONG }
    codex.continuationId = 'codex-session'
    const { ctx, collect } = await setup(claude, true, [codex])

    await collect('harness-session-a', 'claude-code')
    await collect('harness-session-a', 'codex')
    await collect('harness-session-a', 'codex')

    expect(claude.calls[0]!.continueFrom).toBeUndefined()
    expect(codex.calls[0]!.continueFrom).toBeUndefined()
    expect(codex.calls[1]!.continueFrom).toBe('codex-session')
    await ctx.fiber.dispose()
  })

  it('does not resume when the continuation option is off', async () => {
    const fake = new FakeProvider('codex')
    fake.result = { stopReason: 'completed', output: PONG }
    fake.continuationId = 'engine-session-1'
    const { ctx, collect } = await setup(fake, false)

    await collect('harness-session-a')
    await collect('harness-session-a')
    expect(fake.calls[1]!.continueFrom).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
