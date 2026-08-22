/**
 * Claude Code reasoning-effort vocabulary and SDK option mapping.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/effort
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk'

/** Harness effort ids accepted for Claude Code, mapped to the SDK vocabulary. */
export const CLAUDE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** A Claude Code effort identifier accepted by the native SDK. */
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

/**
 * Map a Harness effort id to Claude Code SDK options.
 * @param effort - Harness reasoning effort identifier, or `undefined` for native default.
 * @returns SDK effort or thinking options.
 */
export function claudeEffortOptions(effort: string | undefined): Pick<Options, 'effort' | 'thinking'> {
  switch (effort) {
    case undefined:
    case 'high':
      return {}
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'low':
      return { effort: 'low' }
    case 'medium':
      return { effort: 'medium' }
    case 'xhigh':
      return { effort: 'xhigh' }
    case 'max':
      return { effort: 'max' }
    default:
      throw new Error(`subagent-claude-code: unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
}
