import path from "node:path"

// Browser instances are request-scoped. Share ordering across them so asynchronous
// saves cannot interleave and a read cannot observe a half-written save.
const pending = new Map<string, Promise<unknown>>()

export function pathAccessKey(file: string): string {
  const resolved = path.resolve(file)
  return `lex:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`
}

export function canonicalAccessKey(file: string): string {
  const resolved = path.resolve(file)
  return `canon:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`
}

export function identityAccessKey(dev: bigint | number, ino: bigint | number): string {
  return `id:${dev}:${ino}`
}

export async function withFileAccessKeys<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort()
  if (ordered.length === 0) return operation()
  const run = (index: number): Promise<T> => {
    if (index >= ordered.length) return operation()
    const key = ordered[index]
    const previous = pending.get(key)
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => run(index + 1))
    pending.set(key, current)
    return current.finally(() => { if (pending.get(key) === current) pending.delete(key) })
  }
  return run(0)
}

export function withFileAccess<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withFileAccessKeys([pathAccessKey(file)], operation)
}
