/**
 * Claude Code reasoning-effort vocabulary and SDK option mapping.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/effort
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * Map a Harness effort id to Claude Code SDK options.
 * @param effort - Harness reasoning effort id, or `undefined` to keep the CLI setting.
 * @returns SDK `thinking` (for `off`) or `effort` options; empty when omitted.
 */
export function claudeEffortOptions(effort: string | undefined): Pick<Options, 'effort' | 'thinking'> {
  switch (effort) {
    case undefined:
      return {}
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return { effort }
    default:
      throw new Error(`subagent-claude-code: unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
}
