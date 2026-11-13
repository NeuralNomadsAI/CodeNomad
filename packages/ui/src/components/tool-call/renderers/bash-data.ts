import type { ToolState } from "../../../types/tool-state"
import { isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"

/**
 * A shell call the user interrupted fails with `<output so far>\n\n<notice>` and metadata
 * `{ interrupted: true, notice }`: the output renders like a finished call's, the notice as the error.
 */
export function interruptedShellOutput(state: ToolState | undefined): { output: string; notice: string } | undefined {
  if (!state || !isToolStateError(state)) return undefined
  const { metadata } = readToolStatePayload(state)
  const error = (state as { error?: unknown }).error
  const notice = metadata.notice
  if (metadata.interrupted !== true || typeof notice !== "string" || !notice || typeof error !== "string" || !error.endsWith(notice)) return undefined
  return { output: error.slice(0, error.length - notice.length).replace(/\n\n$/, ""), notice }
}

/** The output a shell call shows: its result, an interrupted call's output so far, or live progress output. */
export function shellOutput(state: ToolState | undefined): unknown {
  if (!state || state.status === "pending") return undefined
  if (isToolStateCompleted(state)) return state.output
  const interrupted = interruptedShellOutput(state)
  if (interrupted) return interrupted.output || undefined
  const { metadata } = readToolStatePayload(state)
  return (isToolStateRunning(state) || isToolStateError(state)) && metadata.output ? metadata.output : undefined
}
