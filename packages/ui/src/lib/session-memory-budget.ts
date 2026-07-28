export const MAX_HOT_SESSION_MESSAGE_BYTES = 64 * 1024 * 1024

export interface SessionMemoryEntry {
  key: string
  byteSize: number
  lastTouched: number
  protected: boolean
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get
const sharedBufferPrototype = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype
const sharedBufferByteLength = sharedBufferPrototype && Object.getOwnPropertyDescriptor(sharedBufferPrototype, "byteLength")?.get
const sharedBufferGrowable = sharedBufferPrototype && Object.getOwnPropertyDescriptor(sharedBufferPrototype, "growable")?.get

function readBufferSize(value: object): { byteLength: number; growable: boolean } | undefined {
  try {
    if (arrayBufferByteLength) {
      const byteLength = arrayBufferByteLength.call(value) as number
      return { byteLength, growable: Boolean(arrayBufferResizable?.call(value)) }
    }
  } catch {
    // Not an ArrayBuffer.
  }
  try {
    if (sharedBufferByteLength) {
      const byteLength = sharedBufferByteLength.call(value) as number
      return { byteLength, growable: Boolean(sharedBufferGrowable?.call(value)) }
    }
  } catch {
    // Not a SharedArrayBuffer.
  }
  return undefined
}

function measureRetainedBytes(value: unknown, limit: number): number {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  let total = 0
  while (pending.length > 0 && total <= limit) {
    const current = pending.pop()
    if (typeof current === "string") total += current.length * 2 + 16
    else if (typeof current === "number" || typeof current === "bigint") total += 8
    else if (typeof current === "boolean") total += 4
    else if (current && typeof current === "object") {
      const buffer = readBufferSize(current)
      if (buffer) {
        total += buffer.growable ? limit + 1 : buffer.byteLength
        continue
      }
      if (ArrayBuffer.isView(current)) {
        const backing = readBufferSize(current.buffer)
        total += backing?.growable ? limit + 1 : backing?.byteLength ?? current.byteLength
        continue
      }
      if (seen.has(current)) continue
      seen.add(current)
      total += Array.isArray(current) ? 24 + current.length * 8 : 32
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue
        total += key.length * 2 + 8
        if (total > limit) break
        pending.push((current as Record<string, unknown>)[key])
      }
    }
  }
  return total
}

export function estimateRetainedBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  return measureRetainedBytes(value, limit)
}

export function exceedsRetainedByteLimit(value: unknown, limit: number): boolean {
  return measureRetainedBytes(value, limit) > limit
}

export function selectSessionMemoryEvictions(
  entries: readonly SessionMemoryEntry[],
  byteLimit = MAX_HOT_SESSION_MESSAGE_BYTES,
): string[] {
  let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.byteSize), 0)
  if (total <= byteLimit) return []
  const candidates = entries
    .filter((entry) => !entry.protected)
    .sort((left, right) => left.lastTouched - right.lastTouched || right.byteSize - left.byteSize || left.key.localeCompare(right.key))
  const evictions: string[] = []
  for (const entry of candidates) {
    if (total <= byteLimit) break
    evictions.push(entry.key)
    total -= Math.max(0, entry.byteSize)
  }
  return evictions
}
