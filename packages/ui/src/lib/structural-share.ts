/** Identity of an array item for matching across publications. */
function itemKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["id", "missionId", "sessionId"]) if (typeof record[key] === "string") return `${key}:${record[key]}`
  return undefined
}

/** Whether an object's identity carries metadata (WeakMap entries): such an object is
 * published as itself, whole, and never stands for another one. */
export type PinnedIdentity = (value: object) => boolean

/**
 * Returns `next` with every part that deep-equals `previous` replaced by the previous
 * object, so keyed lists and memos see unchanged rows as unchanged. Array items match
 * by `id`/`missionId`/`sessionId` when they have one, otherwise by position. Plain
 * JSON-like data only (objects, arrays, primitives); other objects are compared by identity.
 * `pinned` objects (identity metadata) are kept as `next` holds them and are never reused.
 */
export function shareUnchanged<T>(previous: unknown, next: T, pinned?: PinnedIdentity): T {
  if (Object.is(previous, next)) return next
  if (pinned && next && typeof next === "object" && pinned(next)) return next
  if (pinned && previous && typeof previous === "object" && pinned(previous)) previous = undefined
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    const byKey = new Map<string, unknown>()
    for (const item of previous) { const key = itemKey(item); if (key !== undefined && !byKey.has(key)) byKey.set(key, item) }
    let same = previous.length === next.length
    const shared = next.map((item, index) => {
      const key = itemKey(item)
      const value = shareUnchanged(key === undefined ? previous[index] : byKey.get(key), item, pinned)
      if (value !== previous[index]) same = false
      return value
    })
    return settle(previous, next, shared, same && shared.every((value, index) => value === previous[index]), shared.every((value, index) => value === next[index]))
  }
  if (!isPlainObject(next) || !isPlainObject(previous)) return next
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(previous).length
  const shared: Record<string, unknown> = {}
  for (const key of keys) {
    const value = shareUnchanged(previous[key], (next as Record<string, unknown>)[key], pinned)
    if (!Object.prototype.hasOwnProperty.call(previous, key) || value !== previous[key]) same = false
    shared[key] = value
  }
  return settle(previous, next, shared, same, keys.every(key => shared[key] === (next as Record<string, unknown>)[key]))
}

function settle<T>(previous: object, next: T, shared: unknown, equalsPrevious: boolean, equalsNext: boolean): T {
  return (equalsPrevious ? previous : equalsNext ? next : shared) as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
