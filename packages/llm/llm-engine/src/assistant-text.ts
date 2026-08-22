/**
 * Last-assistant-text aggregation over a session event range.
 * @module @deepseek-ai/dsh-llm-engine/assistant-text
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The text of the last non-empty assistant message at or after `fromSeq`.
 * One-shot drivers that print a session's final answer from its durable event
 * log share this aggregation so they agree on which assistant text is "the
 * answer". Events before `fromSeq` and events before the interval's
 * `turn/start` are ignored, so a driver reading a session that already holds
 * earlier turns reports only its own run.
 * @param events - the session's event stream.
 * @param fromSeq - first event index belonging to the owned run interval.
 * @returns the concatenated text blocks of the last assistant message whose
 *   text is non-empty, or `''` when the interval has none.
 */
export function lastAssistantText(events: readonly SessionEvent[], fromSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}
