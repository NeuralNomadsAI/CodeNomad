const admissions = new Map<string, Promise<unknown>>()

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
