/**
 * Codex model discovery: one short-lived `codex app-server --stdio` child that
 * answers `model/list` and is then torn down. The child's stdin stays open
 * until disposal because the app-server exits on EOF without answering
 * outstanding requests.
 *
 * @module @deepseek-ai/dsh-subagent-codex/models
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  codexAppServerArgv,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
} from './run.ts'
import { CodexAppServerWire, type CodexModelInfo } from './wire.ts'

export type { CodexModelInfo } from './wire.ts'

/**
 * Bound on the discovery child's retained stderr. The bytes are never read:
 * collecting them keeps CLI diagnostics off the Host's own stderr.
 */
const STDERR_LIMIT = 4_096

/** Fully resolved inputs for one `model/list` query. */
export interface CodexModelListSpec {
  /** Working directory for the discovery child. */
  readonly cwd: string
  /** Deadline in milliseconds for the whole handshake-and-query exchange. */
  readonly timeoutMs: number
  /** Explicit child environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/**
 * Query the installed app-server for the models it advertises.
 * @param spec - Workspace, deadline, environment, and process service for the query.
 * @returns the advertised models, hidden entries excluded.
 * @throws when the child cannot start, refuses the request, exits early,
 * answers something this protocol adapter does not accept, or misses the deadline.
 */
export async function listCodexModels(spec: CodexModelListSpec): Promise<readonly CodexModelInfo[]> {
  const child = spec.spawn({
    argv: codexAppServerArgv(),
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: STDERR_LIMIT } },
    graceMs: DEFAULT_DISPOSE_GRACE_MS,
    env: spec.env,
  })
  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    // model/list never starts a thread, so the permission mode is never sent.
    DEFAULT_CODEX_PERMISSION_MODE,
  )
  const exited: Promise<never> = child.done.then(
    outcome => Promise.reject(new Error(
      'subagent-codex: app-server exited before model/list answered '
      + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )),
    /* v8 ignore next -- the subprocess seam rejects spawn failures with Error. */
    (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  )
  // Disposal below closes the child, so this rejection also arrives on the
  // success path, after the race that could still observe it has settled.
  exited.catch(() => {})
  const deadline = new AbortController()
  const timer = setTimeout(() => {
    deadline.abort(new Error(`subagent-codex: model/list did not answer within ${spec.timeoutMs}ms`))
  }, spec.timeoutMs)
  try {
    wire.start()
    await Promise.race([wire.initialize(deadline.signal), exited])
    return await Promise.race([wire.listModels(deadline.signal), exited])
  } finally {
    clearTimeout(timer)
    await disposeCodexChild(wire, child)
  }
}
