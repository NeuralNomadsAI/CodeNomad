const queues = new Map<string, Promise<void>>()

export function runMissionExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  queues.set(key, settled)
  return result.finally(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
}
