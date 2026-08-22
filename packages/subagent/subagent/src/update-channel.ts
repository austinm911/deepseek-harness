/**
 * Buffered live-update channel shared by subagent providers.
 *
 * @module @deepseek-ai/dsh-subagent/update-channel
 */

import type { SubagentUpdate } from './types.ts'

/** A push channel whose async iterator drains live updates. */
export interface UpdateChannel {
  /** Publish one update, buffering it until consumed. */
  push(update: SubagentUpdate): void
  /** Close the channel after already-buffered updates drain. */
  end(): void
  /** Consume buffered updates until the channel closes. */
  [Symbol.asyncIterator](): AsyncIterator<SubagentUpdate>
}

/**
 * Build a live update channel: pushed values buffer until the iterator
 * consumes them; `end()` terminates iteration.
 * @returns the push/end facade plus an async iterator over the stream.
 */
export function updateChannel(): UpdateChannel {
  const queue: SubagentUpdate[] = []
  let closed = false
  let waiter: { resolve: () => void } | undefined
  const wake = (): void => {
    if (waiter !== undefined) {
      waiter.resolve()
      waiter = undefined
    }
  }
  return {
    push(update) {
      queue.push(update)
      wake()
    },
    end() {
      closed = true
      wake()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as SubagentUpdate
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          waiter = { resolve }
        })
      }
    },
  }
}
