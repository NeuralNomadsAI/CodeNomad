const encoder = new TextEncoder()
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson((value as Record<string, unknown>)[key])]))
}
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value))
  if (serialized === undefined) throw new TypeError("Client state partition must be JSON-serializable")
  return serialized
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

export interface EncodedPartition { key: string; text: string; bytes: number }
// Saves repeat most partitions unchanged; reuse their canonical text and key by plain
// JSON, which equal values share. Callers pass normalized JSON data only (no Date,
// toJSON or undefined members), so equal plain JSON means equal canonical JSON.
// Bounded LRU (each entry holds two serialisations): about 16 M characters of state
// stay cached; only larger, attachment-heavy snapshots miss.
const MAX_CACHED_CHARACTERS = 32 * 1024 * 1024
const cache = new Map<string, EncodedPartition>()
let cachedCharacters = 0
/** A partition over `maxBytes` comes back unhashed (empty key) and uncached, for the caller to reject. */
export async function encodePartition(value: unknown, maxBytes = Infinity): Promise<EncodedPartition> {
  const plain = JSON.stringify(value)
  if (plain === undefined) throw new TypeError("Client state partition must be JSON-serializable")
  const hit = cache.get(plain)
  if (hit) { cache.delete(plain); cache.set(plain, hit); return hit }
  const text = canonicalJson(value)
  const bytes = encoder.encode(text).byteLength
  if (bytes > maxBytes) return { key: "", text, bytes }
  const encoded = { key: await sha256(text), text, bytes }
  // A concurrent call for the same value may have stored it during the digest.
  const stored = cache.get(plain)
  if (stored) return stored
  cache.set(plain, encoded)
  cachedCharacters += plain.length + text.length
  for (const [oldest, entry] of cache) {
    if (cachedCharacters <= MAX_CACHED_CHARACTERS) break
    cache.delete(oldest)
    cachedCharacters -= oldest.length + entry.text.length
  }
  return encoded
}
