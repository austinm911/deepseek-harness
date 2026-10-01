/**
 * Engine adapter behavior with the backends' run starters replaced by scripted
 * fakes: stream grammar, per-session native resume, effort/model mapping,
 * refusal surfaces, and codex catalog fallback. No product process starts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { CodexRunSpec } from '@deepseek-ai/dsh-subagent-codex'
import type { ClaudeCodeRunSpec } from '@deepseek-ai/dsh-subagent-claude-code'
// vi.mock below is hoisted above this import, so the adapter binds the fakes.
import { EngineLlmAdapter, type NativeSessionIds } from '../src/adapter.ts'

interface Script {
  deltas: string[]
  nativeId: string
  result: Pick<SubagentResult, 'stopReason' | 'output'> & { diagnostic?: string }
}

const backend = vi.hoisted(() => ({
  codexSpecs: [] as unknown[],
  prompts: [] as string[],
  claudeSpecs: [] as unknown[],
  script: undefined as Script | undefined,
  models: vi.fn(),
  claudeModels: vi.fn(),
}))

function fakeRun(script: Script, onDelta: (text: string) => void, onId: (id: string) => void): SubagentRun {
  onId(script.nativeId)
  const result = (async () => {
    for (const text of script.deltas) {
      await Promise.resolve()
      onDelta(text)
    }
    return script.result
  })()
  return {
    id: 'run' as SubagentRun['id'],
    localAgent: undefined,
    result,
    dispose: () => Promise.resolve(),
  }
}

vi.mock('@deepseek-ai/dsh-subagent-codex', () => ({
  CODEX_PERMISSION_MODES: ['never', 'approve-for-me', 'dangerously-bypass-approvals-and-sandbox'],
  DEFAULT_DISPOSE_GRACE_MS: 3000,
  listCodexModels: backend.models,
  startCodexRun: (request: { prompt: Array<{ text: string }> }, spec: CodexRunSpec) => {
    backend.codexSpecs.push(spec)
    backend.prompts.push(request.prompt.map(block => block.text).join(''))
    const script = backend.script
    if (script === undefined) return Promise.reject(new Error('app-server did not start'))
    return Promise.resolve(fakeRun(script, spec.onTextDelta ?? (() => {}), spec.onThreadId ?? (() => {})))
  },
}))

vi.mock('@deepseek-ai/dsh-subagent-claude-code', () => ({
  CLAUDE_CODE_PERMISSION_MODES: ['dontAsk', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
  listClaudeCodeModels: backend.claudeModels,
  startClaudeCodeRun: (_request: unknown, spec: ClaudeCodeRunSpec) => {
    backend.claudeSpecs.push(spec)
    const script = backend.script
    if (script === undefined) return Promise.reject(new Error('sdk did not start'))
    return Promise.resolve(fakeRun(script, spec.onTextDelta ?? (() => {}), spec.onSessionId ?? (() => {})))
  },
}))

const OPTIONS = {
  continuation: true,
  modelDiscovery: true,
  discoveryTimeoutMs: 1000,
  codexContextWindow: 272_000,
  claudeContextWindow: 1_000_000,
  codexPermissionMode: 'approve-for-me',
  claudePermissionMode: 'acceptEdits',
  claudeEnv: {},
  disposeGraceMs: 3000,
} as const

/**
 * `cwd: null` models an initiating Agent whose session has no working directory.
 * Passing one `sessions` map to two adapters models an app restart over the same store.
 */
function adapter(cwd: string | null = '/work', sessions = new Map<string, NativeSessionIds>()) {
  const ctx = {
    get: (name: string) => name === 'agents'
      ? { currentInitiator: () => ({ session: { header: { cwd: cwd ?? undefined } } }) }
      : undefined,
    subprocess: { spawn: vi.fn() },
    logger: { warn: vi.fn() },
  }
  const table = {
    get: (key: string) => sessions.get(key),
    put: (key: string, value: NativeSessionIds) => { sessions.set(key, value); return Promise.resolve() },
  }
  return {
    engine: new EngineLlmAdapter(ctx as unknown as Context, OPTIONS, table),
    sessions,
    warn: ctx.logger.warn,
  }
}

function call(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codex',
    model: 'native',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the bug' }] }],
    sessionId: SessionId('session-1'),
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const completed = (text: string, nativeId = 'thread-1'): Script => ({
  deltas: ['Hel', 'lo'],
  nativeId,
  result: { stopReason: 'completed', output: [{ type: 'text', text }] },
})

beforeEach(() => {
  backend.codexSpecs.length = 0
  backend.prompts.length = 0
  backend.claudeSpecs.length = 0
  backend.script = undefined
  backend.models.mockReset()
  backend.claudeModels.mockReset()
})

describe('EngineLlmAdapter.stream', () => {
  it('streams live deltas, then ends the block with the final answer', async () => {
    backend.script = completed('Hello there')
    const chunks = await collect(adapter().engine.stream(call()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello there' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('resumes the native thread per session and route, including after a restart', async () => {
    const { engine, sessions } = adapter()
    backend.script = completed('one', 'thread-A')
    await collect(engine.stream(call()))
    await collect(engine.stream(call()))
    await collect(engine.stream(call({ sessionId: SessionId('session-2') })))
    await collect(adapter('/work', sessions).engine.stream(call()))
    expect(backend.codexSpecs.map(spec => (spec as CodexRunSpec).resumeThreadId))
      .toEqual([undefined, 'thread-A', undefined, 'thread-A'])
    expect((backend.codexSpecs[0] as CodexRunSpec).persistThread).toBe(true)
  })

  it('keeps each route\'s native id when a session switches engines', async () => {
    const { engine, sessions } = adapter()
    backend.script = completed('one', 'thread-A')
    await collect(engine.stream(call()))
    backend.script = completed('two', 'claude-B')
    await collect(engine.stream(call({ provider: 'claude-code' })))
    expect(sessions.get('session-1')).toEqual({ codex: 'thread-A', 'claude-code': 'claude-B' })
  })

  it('drops a dead native id after a failed resumed turn, so the next turn starts fresh', async () => {
    const sessions = new Map<string, NativeSessionIds>([['session-1', { codex: 'gone', 'claude-code': 'claude-B' }]])
    const { engine } = adapter('/work', sessions)
    backend.script = { deltas: [], nativeId: 'gone', result: { stopReason: 'error', output: [], diagnostic: 'No conversation found' } }
    const failed = await collect(engine.stream(call()))
    expect(failed.at(-1)).toMatchObject({
      reason: { failure: { message: expect.stringContaining('next message starts a new Codex conversation') } },
    })
    expect(sessions.get('session-1')).toEqual({ 'claude-code': 'claude-B' })
    backend.script = completed('fresh', 'thread-new')
    await collect(engine.stream(call()))
    expect(backend.codexSpecs.map(spec => (spec as CodexRunSpec).resumeThreadId)).toEqual(['gone', undefined])
    expect(sessions.get('session-1')).toEqual({ codex: 'thread-new', 'claude-code': 'claude-B' })
  })

  it('maps effort off to minimal for codex, keeps native model unset, and sends explicit models', async () => {
    const { engine } = adapter()
    backend.script = completed('ok')
    await collect(engine.stream(call({ reasoningEffort: ReasoningEffortId('off') })))
    await collect(engine.stream(call({ model: 'gpt-6-luna', reasoningEffort: ReasoningEffortId('high') })))
    const [first, second] = backend.codexSpecs as CodexRunSpec[]
    expect(first).toMatchObject({ effort: 'minimal', cwd: '/work', permissionMode: 'approve-for-me' })
    expect(first).not.toHaveProperty('model')
    expect(second).toMatchObject({ effort: 'high', model: 'gpt-6-luna' })
  })

  it('routes claude-code turns to the Claude backend with its own resume id', async () => {
    const { engine } = adapter()
    backend.script = completed('ok', 'claude-session')
    await collect(engine.stream(call({ provider: 'claude-code', reasoningEffort: ReasoningEffortId('off') })))
    await collect(engine.stream(call({ provider: 'claude-code' })))
    const specs = backend.claudeSpecs as ClaudeCodeRunSpec[]
    expect(specs[0]).toMatchObject({ effort: 'off', permissionMode: 'acceptEdits', persistSession: true })
    expect(specs[1]?.resumeSessionId).toBe('claude-session')
    expect(backend.codexSpecs).toHaveLength(0)
  })

  it('refuses auxiliary purposes without starting an engine', async () => {
    const chunks = await collect(adapter().engine.stream(call({ purpose: 'session-title' })))
    expect(chunks).toEqual([expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error', failure: expect.objectContaining({ code: 'UNSUPPORTED_PURPOSE' }) }),
    })])
    expect(backend.codexSpecs).toHaveLength(0)
  })

  it('ignores injected context messages when picking the prompt', async () => {
    backend.script = completed('ok')
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'real ask' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'AGENTS.md dump' }], source: { kind: 'plugin' } },
    ] as unknown as GenerateOptions['messages']
    await collect(adapter().engine.stream(call({ messages })))
    expect(backend.prompts).toEqual(['real ask'])
  })

  it('reports an engine failure with its diagnostic and a start failure with its cause', async () => {
    const { engine } = adapter()
    backend.script = {
      deltas: [],
      nativeId: 't',
      result: { stopReason: 'error', output: [], diagnostic: 'not logged in' },
    }
    const failed = await collect(engine.stream(call()))
    expect(failed.at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'ENGINE_FAILURE', message: expect.stringContaining('not logged in') } },
    })
    backend.script = undefined
    const notStarted = await collect(engine.stream(call()))
    expect(notStarted).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ failure: expect.objectContaining({ message: expect.stringContaining('app-server did not start') }) }),
    })])
  })

  it('fails without a workspace instead of running in the host cwd', async () => {
    backend.script = completed('ok')
    const chunks = await collect(adapter(null).engine.stream(call()))
    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { code: 'NO_WORKSPACE' } } })
    expect(backend.codexSpecs).toHaveLength(0)
  })
})

describe('EngineLlmAdapter catalogs', () => {
  it('advertises discovered codex models with harness effort ids, native first', async () => {
    backend.models.mockResolvedValue([
      { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['minimal', 'low', 'high'], defaultEffort: 'high' },
    ])
    const { engine } = adapter()
    expect((await engine.listModels('codex')).map(model => model.id)).toEqual(['native', 'gpt-6-luna'])
    const luna = await engine.resolveModel('codex', 'gpt-6-luna')
    expect(luna.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high'])
    expect(luna.reasoning?.defaultEffort).toBe('high')
    await engine.listModels('codex')
    expect(backend.models).toHaveBeenCalledTimes(1)
  })

  it('advertises discovered claude models with off plus their reported efforts', async () => {
    backend.claudeModels.mockResolvedValue([
      { id: 'claude-opus-5-5', displayName: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', efforts: [] },
    ])
    const { engine } = adapter()
    expect((await engine.listModels('claude-code')).map(model => model.id))
      .toEqual(['native', 'claude-opus-5-5', 'claude-haiku-4-5'])
    expect((await engine.resolveModel('claude-code', 'claude-opus-5-5')).reasoning?.efforts.map(effort => effort.id))
      .toEqual(['off', 'low', 'high', 'max'])
    expect((await engine.resolveModel('claude-code', 'claude-haiku-4-5')).reasoning?.efforts.map(effort => effort.id))
      .toEqual(['off'])
    expect(backend.models).not.toHaveBeenCalled()
  })

  it('falls back to native alone and logs the cause when discovery fails', async () => {
    backend.models.mockRejectedValue(new Error('not logged in'))
    const { engine, warn } = adapter()
    expect((await engine.listModels('codex')).map(model => model.id)).toEqual(['native'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not logged in'))
  })

  it('still resolves a model the catalog does not list, so the CLI decides', async () => {
    backend.models.mockRejectedValue(new Error('offline'))
    const resolved = await adapter().engine.resolveModel('codex', 'gpt-6-luna')
    expect(resolved).toMatchObject({ id: 'gpt-6-luna', context: { contextWindow: 272_000 } })
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toContain('off')
  })
})
