import path from "node:path"

// Browser instances are request-scoped. Share ordering across them so asynchronous
// saves cannot interleave and a read cannot observe a half-written save.
const pending = new Map<string, Promise<unknown>>()

export async function withFileAccess<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(file)
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const previous = pending.get(key)
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation)
  pending.set(key, current)
  try { return await current }
  finally { if (pending.get(key) === current) pending.delete(key) }
}
