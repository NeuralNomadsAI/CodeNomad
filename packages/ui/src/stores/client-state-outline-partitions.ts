import { canonicalJson, sha256 } from "./client-state-partition-json"
import { normalizePersistedOutline, type PersistedOutline } from "./session-outline-persistence"

const encoded = new WeakMap<PersistedOutline, Promise<{ descriptor: object; partitions: Record<string, string> }>>()
export function encodeOutlinePartitions(value: PersistedOutline) {
  let pending = encoded.get(value)
  if (!pending) {
    pending = (async () => {
      const partitions: Record<string, string> = Object.create(null), entryPartitions: string[] = []
      // Even maximally escaped 256-character IDs fit the native 1 MiB leaf limit.
      for (let offset = 0; offset < value.entries.length; offset += 512) {
        const text = canonicalJson({ format: 1, index: offset / 512, entries: value.entries.slice(offset, offset + 512) })
        const key = await sha256(text)
        partitions[key] = text; entryPartitions.push(key)
      }
      const { entries: _, ...metadata } = value
      return { descriptor: { ...metadata, entryPartitions }, partitions }
    })()
    // Only normalized frozen indexes are memoized across frequent draft/scroll captures.
    if (Object.isFrozen(value)) encoded.set(value, pending)
  }
  return pending
}

export async function decodeOutlinePartitions(value: unknown, allowed: ReadonlySet<string>, referenced: Set<string>,
  load: (key: string) => Promise<Record<string, unknown> | null>): Promise<PersistedOutline | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const descriptor = value as Record<string, unknown>, keys = descriptor.entryPartitions
  if (!Array.isArray(keys) || keys.length > 391 || new Set(keys).size !== keys.length
    || !keys.every(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key) && allowed.has(key))) return
  keys.forEach(key => referenced.add(key))
  const entries: unknown[] = []
  for (let index = 0; index < keys.length; index++) {
    const chunk = await load(keys[index]).catch(() => null)
    if (!chunk || chunk.format !== 1 || chunk.index !== index || !Array.isArray(chunk.entries)
      || chunk.entries.length > 512 || (index < keys.length - 1 && chunk.entries.length !== 512)) return
    entries.push(...chunk.entries)
  }
  return normalizePersistedOutline({ ...descriptor, entries })
}
