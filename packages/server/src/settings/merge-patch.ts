type PlainObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainObject {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * RFC 7396-ish merge patch with explicit null deletes.
 * - Objects merge recursively
 * - Arrays/scalars replace
 * - null deletes keys
 */
export function applyMergePatch(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch
  }

  const base: PlainObject = isPlainObject(current) ? { ...(current as PlainObject) } : {}

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key]
      continue
    }

    const existing = base[key]
    if (isPlainObject(value) && isPlainObject(existing)) {
      base[key] = applyMergePatch(existing, value)
      continue
    }

    base[key] = value
  }

  return base
}
