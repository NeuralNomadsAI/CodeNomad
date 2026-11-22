import { normalizeSessionCatalog, type PersistedSessionCatalogEntry } from "./session-catalog-persistence"
import { encodePartition, type EncodedPartition } from "./client-state-partition-json"

const encoder = new TextEncoder()
const CHUNK_BYTES = 768 * 1024

interface CatalogChunk { start: number; end: number; partition: EncodedPartition }
export interface EncodedCatalog {
  rows: readonly PersistedSessionCatalogEntry[]
  chunks: CatalogChunk[]
}
const sizes = new WeakMap<PersistedSessionCatalogEntry, number>()

export async function encodeCatalogPartitions(input: PersistedSessionCatalogEntry[], previous?: EncodedCatalog): Promise<EncodedCatalog> {
  const rows = normalizeSessionCatalog(input)
  if (!rows) throw new Error("Invalid session catalog")
  if (rows === previous?.rows) return previous
  const chunks: CatalogChunk[] = []
  let start = 0, bytes = 0
  const flush = async (end: number) => {
    const index = chunks.length, old = previous?.chunks[index]
    if (old && old.end - old.start === end - start
      && rows.slice(start, end).every((row, offset) => row === previous!.rows[old.start + offset])) {
      chunks.push({ start, end, partition: old.partition })
    } else {
      chunks.push({ start, end, partition: await encodePartition({ format: 1, index, entries: rows.slice(start, end) }) })
    }
    start = end; bytes = 0
  }
  for (const [index, row] of rows.entries()) {
    let size = sizes.get(row)
    if (size === undefined) {
      // Canonical and plain JSON differ only in key order, so they have the same size.
      size = encoder.encode(JSON.stringify(row)).byteLength + 1
      sizes.set(row, size)
    }
    if (size > CHUNK_BYTES) throw new Error("Session catalog entry exceeds the native partition size")
    if (bytes + size > CHUNK_BYTES) await flush(index)
    bytes += size
  }
  if (start < rows.length) await flush(rows.length)
  return { rows, chunks }
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
