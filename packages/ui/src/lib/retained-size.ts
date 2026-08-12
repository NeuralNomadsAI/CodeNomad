const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get

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
  let total = 0
  while (pending.length > 0 && total <= limit) {
    const current = pending.pop()
    if (typeof current === "string") total += current.length * 2 + 16
    else if (typeof current === "number" || typeof current === "bigint") total += 8
    else if (typeof current === "boolean") total += 4
    else if (current && typeof current === "object") {
      const bytes = bufferSize(current)
      if (bytes !== undefined) {
        total += bytes.growable ? limit + 1 : bytes.bytes
        continue
      }
      if (ArrayBuffer.isView(current)) {
        const backing = bufferSize(current.buffer)
        total += backing?.growable ? limit + 1 : backing?.bytes ?? current.byteLength
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

export function exceedsRetainedByteLimit(value: unknown, limit: number): boolean {
  return estimateRetainedBytes(value, limit) > limit
}

export async function estimateRetainedBytesIncrementally(
  value: unknown,
  options: { signal?: AbortSignal; yieldEvery?: number } = {},
): Promise<number> {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  const yieldEvery = Math.max(1, options.yieldEvery ?? 500)
  let processed = 0
  let total = 0
  while (pending.length > 0) {
    options.signal?.throwIfAborted()
    if (++processed % yieldEvery === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const current = pending.pop()
    if (typeof current === "string") total += current.length * 2 + 16
    else if (typeof current === "number" || typeof current === "bigint") total += 8
    else if (typeof current === "boolean") total += 4
    else if (current && typeof current === "object") {
      const bytes = bufferSize(current)
      if (bytes !== undefined) {
        total += bytes.growable ? Number.POSITIVE_INFINITY : bytes.bytes
        continue
      }
      if (ArrayBuffer.isView(current)) {
        const backing = bufferSize(current.buffer)
        total += backing?.growable ? Number.POSITIVE_INFINITY : backing?.bytes ?? current.byteLength
        continue
      }
      if (seen.has(current)) continue
      seen.add(current)
      total += Array.isArray(current) ? 24 + current.length * 8 : 32
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue
        total += key.length * 2 + 8
        pending.push((current as Record<string, unknown>)[key])
      }
    }
  }
  options.signal?.throwIfAborted()
  return total
}
