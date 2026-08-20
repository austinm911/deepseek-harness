/**
 * Keyless real-Loader smoke over the multi-provider leaf: boot the real
 * `cordis.yml`, then assert the provider routes, model catalogs, subagent
 * backends, and tool surface. Also enforces that the leaf's `llm-pi-ai`
 * providers dict stays in sync with the @deepseek-ai/dsh-multi-provider
 * bundle patch — the two must carry the same routes, keys, and model lists.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/inspect-driver.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const packPatchPath = fileURLToPath(new URL('../../../packages/bundle/multi-provider/cordis.patch.yml', import.meta.url))

interface InspectOutput {
  providers: { provider: string; name: string | null; models: string[] }[]
  subagents: string[]
  tools: string[]
}

describe('multi-provider leaf over the real Loader (no key required)', () => {
  // One real Loader boot (tsx cold start + agent spine) exceeds the default
  // per-test budget; the loader smoke itself enforces its own process cap.
  it('registers the pack providers with the pack catalog and the delegation backends', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'multi-provider leaf inspection',
      tempDirPrefix: 'dsh-multi-provider-leaf-',
      binScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
    })

    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as InspectOutput
    // The pack routes, in composition order, with the curated catalogs.
    // Registration order is service-availability driven, not row order: the
    // engine adapter's routes commit before the pi-ai adapter's.
    expect(output.providers.map(entry => entry.provider)).toEqual([
      'claude-code', 'codex', 'google', 'minimax', 'kimi-coding', 'anthropic', 'anthropic-subscription',
    ])
    expect(output.providers[2]).toMatchObject({
      name: 'Gemini',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
    })
    expect(output.providers[3]).toMatchObject({
      name: 'MiniMax',
      models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3'],
    })
    expect(output.providers[4]).toMatchObject({
      name: 'Kimi (Moonshot)',
      models: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    })
    expect(output.providers[5]).toMatchObject({
      name: 'Claude (API)',
      models: ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-4-5'],
    })
    // The subscription route the installed pi-ai catalog does not ship: same
    // model ids as the key route, reached with a Claude Pro/Max OAuth token.
    expect(output.providers[6]).toMatchObject({
      name: 'Claude (Pro/Max subscription)',
      models: ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-4-5'],
    })
    // The engine LLM adapter registers the local CLI routes; the delegation
    // backends serve them with OAuth. The `claude-code` catalog is pinned to
    // the installed Agent SDK's families. The `codex` catalog comes from the
    // installed app-server's `model/list`, so only the CLI-default choice is
    // assertable here: which models a host serves depends on its CLI version
    // and login, and a host with no `codex` at all degrades to this alone.
    expect(output.providers[0]!.name).toBe('Claude Code')
    expect(output.providers[0]!.models).toEqual(expect.arrayContaining([
      'native', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    ]))
    expect(output.providers[1]!.name).toBe('Codex')
    expect(output.providers[1]!.models).toContain('native')

    // The delegation backends load without starting either product.
    expect(output.subagents).toEqual(expect.arrayContaining(['codex', 'claude-code']))

    // The shipped posture: backend tool rows are disabled, so no composed
    // agent grows subagent_codex / subagent_claude_code; the spawn tool rows
    // stay active.
    expect(output.tools).toEqual(expect.arrayContaining(['subagent']))
    expect(output.tools).not.toEqual(expect.arrayContaining(['subagent_codex', 'subagent_claude_code']))
  }, 120_000)

  it('keeps the leaf providers dict in sync with the pack bundle patch', () => {
    const parsed = yaml.load(readFileSync(packPatchPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const entries = parsed as { id?: string; insert?: unknown[]; config?: Record<string, unknown> }[]
    const piAi = entries.find(entry => entry.id === 'llm-pi-ai')
    expect(piAi).toBeDefined()
    const providers = (piAi!.config!['providers'] ?? {}) as Record<
      string, { apiKeyEnv?: string; displayName?: string; models?: { id: string }[] }
    >
    const leaf = yaml.load(readFileSync(fileURLToPath(new URL('../cordis.yml', import.meta.url)), 'utf8'), {
      schema: entryListSchema,
    })
    const leafRows = (leaf as { id?: string; config?: { providers?: Record<string, unknown> } }[]).filter(
      row => row.id === 'llm-pi-ai',
    )
    expect(leafRows).toHaveLength(1)
    const leafProviders = leafRows[0]!.config!.providers!
    expect(Object.keys(leafProviders).sort()).toEqual(Object.keys(providers).sort())
    for (const [route, packProfile] of Object.entries(providers)) {
      const leafProfile = leafProviders[route] as { apiKeyEnv?: string; displayName?: string; models?: { id: string }[] }
      expect(leafProfile.apiKeyEnv).toBe(packProfile.apiKeyEnv)
      expect(leafProfile.displayName).toBe(packProfile.displayName)
      const leafIds = (leafProfile.models ?? []).map(model => model.id).sort()
      const packIds = (packProfile.models ?? []).map(model => model.id).sort()
      expect(leafIds).toEqual(packIds)
    }
  })
})
