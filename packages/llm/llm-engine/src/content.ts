/**
 * Text extraction helpers for engine adapter prompts and results.
 * @module @deepseek-ai/dsh-llm-engine/content
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Concatenate every text block's text in order; `''` when content has no
 * text block. The one shared "the assistant's answer" extraction used by
 * one-shot drivers and result printers, so no consumer re-derives it.
 * @param content - typed model content blocks.
 * @returns the joined text of all text blocks.
 */
export function textOfBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}
