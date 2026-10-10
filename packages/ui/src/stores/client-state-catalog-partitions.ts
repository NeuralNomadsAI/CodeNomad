import { canonicalJson } from "./client-state-partition-json"
import { normalizeSessionCatalog, type PersistedSessionCatalogEntry } from "./session-catalog-persistence"

const encoder = new TextEncoder()
const CHUNK_BYTES = 768 * 1024

export async function encodeCatalogPartitions(rows: PersistedSessionCatalogEntry[], add: (value: unknown) => Promise<string>): Promise<string[]> {
  const keys: string[] = []
  let entries: PersistedSessionCatalogEntry[] = [], bytes = 0
  for (const row of rows) {
    const size = encoder.encode(canonicalJson(row)).byteLength + 1
    if (size > CHUNK_BYTES) throw new Error("Session catalog entry exceeds the native partition size")
    if (bytes + size > CHUNK_BYTES) {
      keys.push(await add({ format: 1, index: keys.length, entries }))
      entries = []; bytes = 0
    }
    entries.push(row); bytes += size
  }
  if (entries.length) keys.push(await add({ format: 1, index: keys.length, entries }))
  return keys
}

export async function decodeCatalogPartitions(value: unknown, allowed: ReadonlySet<string>, referenced: Set<string>,
  load: (key: string) => Promise<Record<string, unknown> | null>): Promise<PersistedSessionCatalogEntry[] | undefined> {
  if (!Array.isArray(value) || new Set(value).size !== value.length
    || !value.every(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key) && allowed.has(key))) return
  value.forEach(key => referenced.add(key))
  const rows: unknown[] = []
  for (const [index, key] of value.entries()) {
    const chunk = await load(key).catch(() => null)
    if (!chunk || chunk.format !== 1 || chunk.index !== index || !Array.isArray(chunk.entries)
      || Object.keys(chunk).sort().join(",") !== "entries,format,index") return
    for (const row of chunk.entries) rows.push(row)
  }
  return normalizeSessionCatalog(rows)
}
