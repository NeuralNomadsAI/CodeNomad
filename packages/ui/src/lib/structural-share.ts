/** Identity of an array item for matching across publications. */
function itemKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["id", "missionId", "sessionId"]) if (typeof record[key] === "string") return `${key}:${record[key]}`
  return undefined
}

/**
 * Returns `next` with every part that deep-equals `previous` replaced by the previous
 * object, so keyed lists and memos see unchanged rows as unchanged. Array items match
 * by `id`/`missionId`/`sessionId` when they have one, otherwise by position. Plain
 * JSON-like data only (objects, arrays, primitives); other objects are compared by identity.
 */
export function shareUnchanged<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    const byKey = new Map<string, unknown>()
    for (const item of previous) { const key = itemKey(item); if (key !== undefined && !byKey.has(key)) byKey.set(key, item) }
    let same = previous.length === next.length
    const shared = next.map((item, index) => {
      const key = itemKey(item)
      const value = shareUnchanged(key === undefined ? previous[index] : byKey.get(key), item)
      if (value !== previous[index]) same = false
      return value
    })
    return (same ? previous : shared) as T
  }
  if (!isPlainObject(next) || !isPlainObject(previous)) return next
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(previous).length
  const shared: Record<string, unknown> = {}
  for (const key of keys) {
    const value = shareUnchanged(previous[key], (next as Record<string, unknown>)[key])
    if (!Object.prototype.hasOwnProperty.call(previous, key) || value !== previous[key]) same = false
    shared[key] = value
  }
  return (same ? previous : shared) as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
