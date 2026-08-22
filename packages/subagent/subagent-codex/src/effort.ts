/**
 * Codex app-server reasoning-effort vocabulary and Harness mappings.
 *
 * @module @deepseek-ai/dsh-subagent-codex/effort
 */

/**
 * The app-server reasoning-effort vocabulary paired with the Harness effort id
 * for each level, in ascending order. The two vocabularies differ in one
 * name: the lowest level is `minimal` on the wire and `off` in the Harness.
 */
const EFFORT_VOCABULARY: readonly (readonly [harness: string, codex: string])[] = [
  ['off', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
  ['ultra', 'ultra'],
]

/**
 * Map a Harness effort id to the Codex app-server effort vocabulary.
 * @param effort - Harness reasoning effort identifier.
 * @returns Codex app-server effort value.
 */
export function codexEffort(effort: string): string {
  const level = EFFORT_VOCABULARY.find(([harness]) => harness === effort)
  if (level === undefined) {
    throw new Error(`subagent-codex: unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
  return level[1]
}

/**
 * Map an app-server effort value back to its Harness effort id.
 * @param effort - Codex app-server effort value.
 * @returns Harness reasoning effort identifier.
 */
export function harnessEffort(effort: string): string {
  const level = EFFORT_VOCABULARY.find(([, codex]) => codex === effort)
  if (level === undefined) {
    throw new Error(`subagent-codex: app-server reported unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
  return level[0]
}
