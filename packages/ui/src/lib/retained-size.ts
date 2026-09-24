const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get
const MAP_ENTRY_BYTES = 24
const SET_ENTRY_BYTES = 16

type RetainedChild = { value: unknown; keyBytes: number }

function bufferSize(value: object): { bytes: number; growable: boolean } | undefined {
  try {
    return { bytes: arrayBufferByteLength?.call(value) as number, growable: Boolean(arrayBufferResizable?.call(value)) }
  } catch {
    return undefined
  }
}

export function estimateRetainedBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  const children: Iterator<RetainedChild>[] = []
  let total = 0
  while ((pending.length > 0 || children.length > 0) && total <= limit) {
    if (pending.length === 0) {
      const child = children[children.length - 1]!.next()
      if (child.done) {
        children.pop()
        continue
      }
      total += child.value.keyBytes
      if (total > limit) break
      pending.push(child.value.value)
    }
    const current = pending.pop()
    if (typeof current === "string") total += current.length * 2 + 16
    else if (typeof current === "number" || typeof current === "bigint") total += 8
    else if (typeof current === "boolean") total += 4
    else if (current && typeof current === "object") {
      if (ArrayBuffer.isView(current)) {
        if (seen.has(current.buffer)) continue
        seen.add(current.buffer)
        const backing = bufferSize(current.buffer as object)
        total += backing?.growable ? limit + 1 : backing?.bytes ?? current.byteLength
        continue
      }
      if (seen.has(current)) continue
      seen.add(current)
      const bytes = bufferSize(current)
      if (bytes !== undefined) {
        total += bytes.growable ? limit + 1 : bytes.bytes
        continue
      }
      total += Array.isArray(current)
        ? 24 + current.length * 8
        : current instanceof Map
          ? 32 + current.size * MAP_ENTRY_BYTES
          : current instanceof Set
            ? 32 + current.size * SET_ENTRY_BYTES
            : 32
      if (total <= limit) children.push(objectChildren(current))
    }
  }
  return total
}

export function exceedsRetainedByteLimit(value: unknown, limit: number): boolean {
  return estimateRetainedBytes(value, limit) > limit
}

export async function estimateRetainedBytesIncrementally(
  value: unknown,
  options: {
    signal?: AbortSignal
    yieldEvery?: number
    rootIterable?: boolean
    maxBytes?: number
    maxNodes?: number
  } = {},
): Promise<number> {
  const seen = new WeakSet<object>()
  const pending: unknown[] = []
  const children: Iterator<RetainedChild>[] = []
  const roots = options.rootIterable ? (value as Iterable<unknown>)[Symbol.iterator]() : undefined
  if (!roots) pending.push(value)
  const yieldEvery = Math.max(1, options.yieldEvery ?? 500)
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY
  let processed = 0
  let total = 0

  while (pending.length > 0 || children.length > 0 || roots) {
    options.signal?.throwIfAborted()
    if (pending.length === 0) {
      const child = children[children.length - 1]?.next()
      if (child && !child.done) {
        total += child.value.keyBytes
        if (total > maxBytes) return Number.POSITIVE_INFINITY
        pending.push(child.value.value)
      } else if (child) {
        children.pop()
        continue
      } else {
        const next = roots!.next()
        if (next.done) break
        pending.push(next.value)
      }
    }
    if (++processed > maxNodes) return Number.POSITIVE_INFINITY
    if (processed % yieldEvery === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      options.signal?.throwIfAborted()
    }
    const current = pending.pop()
    if (typeof current === "string") total += current.length * 2 + 16
    else if (typeof current === "number" || typeof current === "bigint") total += 8
    else if (typeof current === "boolean") total += 4
    else if (current && typeof current === "object") {
      if (ArrayBuffer.isView(current)) {
        if (seen.has(current.buffer)) continue
        seen.add(current.buffer)
        const backing = bufferSize(current.buffer as object)
        total += backing?.growable ? Number.POSITIVE_INFINITY : backing?.bytes ?? current.byteLength
        continue
      }
      if (seen.has(current)) continue
      seen.add(current)
      const bytes = bufferSize(current)
      if (bytes !== undefined) {
        total += bytes.growable ? Number.POSITIVE_INFINITY : bytes.bytes
        continue
      }
      total += Array.isArray(current)
        ? 24 + current.length * 8
        : current instanceof Map
          ? 32 + current.size * MAP_ENTRY_BYTES
          : current instanceof Set
            ? 32 + current.size * SET_ENTRY_BYTES
            : 32
      children.push(objectChildren(current))
    }
    if (total > maxBytes) return Number.POSITIVE_INFINITY
  }
  options.signal?.throwIfAborted()
  return total
}

function* objectChildren(current: object): Generator<RetainedChild> {
  if (current instanceof Map) {
    for (const [key, entry] of current) {
      yield { value: key, keyBytes: 0 }
      yield { value: entry, keyBytes: 0 }
    }
  } else if (current instanceof Set) {
    for (const entry of current) yield { value: entry, keyBytes: 0 }
  }
  for (const key in current) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) continue
    yield { value: (current as Record<string, unknown>)[key], keyBytes: key.length * 2 + 8 }
  }
}
