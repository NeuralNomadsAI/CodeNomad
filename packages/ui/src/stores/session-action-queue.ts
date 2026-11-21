import { captureBackendOperation } from "../lib/backend-operation"

const admissions = new Map<string, { signal: AbortSignal; running: Promise<unknown> }>()

// Native context writes, prompt admission and context reconciliation share an
// order. This waits for HTTP admission, never for the model's execution to end.
export function serializeSessionAction<T>(instanceId: string, sessionId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const operation = captureBackendOperation(instanceId)
  const key = `${instanceId}:${sessionId}`
  const previous = admissions.get(key)
  const run = (previous?.signal === operation.signal ? previous.running : Promise.resolve()).catch(() => undefined).then(() => {
    operation.signal.throwIfAborted()
    return action(operation.signal)
  })
  const settled = run.finally(() => {
    if (admissions.get(key)?.running === settled) admissions.delete(key)
  })
  admissions.set(key, { signal: operation.signal, running: settled })
  return settled
}
