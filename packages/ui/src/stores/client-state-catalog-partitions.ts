import { normalizeSessionCatalog, type PersistedSessionCatalogEntry } from "./session-catalog-persistence"
import { canonicalJson, encodeCanonicalPartition, sha256, type EncodedPartition } from "./client-state-partition-json"

const encoder = new TextEncoder()
const CHUNK_BYTES = 768 * 1024

interface CatalogChunk { start: number; end: number; partition: EncodedPartition }
export interface EncodedCatalog {
  rows: readonly PersistedSessionCatalogEntry[]
  chunks: CatalogChunk[]
}
const encodedRows = new WeakMap<PersistedSessionCatalogEntry, { text: string; bytes: number }>()

function yieldCatalogEncode(): Promise<void> {
  return new Promise(resolve => {
    // Checkpoints can run during window shutdown, when hidden timers may be throttled.
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

export async function encodeCatalogPartitions(input: PersistedSessionCatalogEntry[], previous?: EncodedCatalog): Promise<EncodedCatalog> {
  const rows = normalizeSessionCatalog(input)
  if (!rows) throw new Error("Invalid session catalog")
  if (rows === previous?.rows) return previous
  const chunks: CatalogChunk[] = []
  let start = 0, bytes = 0
  let newRows = 0
  let texts: string[] = []
  const flush = async (end: number) => {
    const index = chunks.length, old = previous?.chunks[index]
    if (old && old.end - old.start === end - start
      && rows.slice(start, end).every((row, offset) => row === previous!.rows[old.start + offset])) {
      chunks.push({ start, end, partition: old.partition })
    } else {
      const text = `{"entries":[${texts.join(",")}],"format":1,"index":${index}}`
      chunks.push({ start, end, partition: await encodeCanonicalPartition(text) })
    }
    start = end; bytes = 0; texts = []
  }
  for (const [index, row] of rows.entries()) {
    let encoded = encodedRows.get(row)
    if (!encoded) {
      // Normalized rows are immutable. Yield during the first large encode;
      // later checkpoints sort only new rows, even when a whole chunk is rehashed.
      if (++newRows % 512 === 0) await yieldCatalogEncode()
      const text = canonicalJson(row)
      encoded = { text, bytes: encoder.encode(text).byteLength + 1 }
      encodedRows.set(row, encoded)
    }
    if (encoded.bytes > CHUNK_BYTES) throw new Error("Session catalog entry exceeds the native partition size")
    if (bytes + encoded.bytes > CHUNK_BYTES) await flush(index)
    texts.push(encoded.text)
    bytes += encoded.bytes
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
