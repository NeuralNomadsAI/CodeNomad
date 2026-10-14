// Content-addressed plugin reloads instantiate this module again in the same
// native host. Keep in-flight project mutations exclusive across incarnations,
// including work already admitted before the old registrations were disposed.
const registryKey = Symbol.for("codenomad.missions.exclusive.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Promise<void>> }
const queues = host[registryKey] ??= new Map<string, Promise<void>>()

export function runMissionExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  queues.set(key, settled)
  return result.finally(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
}
