import { EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE, SESSION_ENVIRONMENT_FAILED_ERROR_CODE } from "../../../server/src/api-types"

const admissions = new Map<string, Promise<unknown>>()

export function sessionActionSuperseded(message: string): Error {
  return Object.assign(new Error(message), { code: "session_action_superseded" })
}

/** A retired action or lost HTTP outcome needs source-local feedback, not replay. */
export function isSessionActionInterrupted(error: unknown): boolean {
  let transport = false
  for (let depth = 0; depth < 5 && error && typeof error === "object"; depth++) {
    const value = error as { code?: string; reason?: string; cause?: unknown }
    if (value.code === "session_action_superseded" || value.code === EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE) return true
    if (value.code === SESSION_ENVIRONMENT_FAILED_ERROR_CODE || value.code === "PROVIDER_ACCOUNT_SELECTION_FAILED") return false
    transport ||= value.reason === "Transport"
    error = value.cause
  }
  return transport
}

// Native context writes, prompt admission and context reconciliation share an
// order. This waits for HTTP admission, never for the model's execution to end.
export function serializeSessionAction<T>(instanceId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const key = `${instanceId}:${sessionId}`
  const run = (admissions.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
  const settled = run.finally(() => {
    if (admissions.get(key) === settled) admissions.delete(key)
  })
  admissions.set(key, settled)
  return settled
}
