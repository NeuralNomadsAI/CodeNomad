import type { OutlineCheckpoint, OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"

export interface PersistedOutline {
  format: 1
  directory: string
  projectID: string
  revert?: string
  entries: OutlineEntry[]
  checkpoints: OutlineCheckpoint[]
}
export interface OutlineBudget { bytes: number; entries: number; indexes: number }
export const outlineBudget = (): OutlineBudget => ({ bytes: 16 * 1024 * 1024, entries: 200_000, indexes: 16 })
const verified = new WeakMap<object, number>()
const types = new Set(["user", "assistant", "system", "synthetic", "skill", "shell", "compaction", "idle", "agent-switched", "model-switched", "location-switched"])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const string = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min

// Frozen normalized values are reused by scroll/draft captures without repeatedly
// traversing/hashing thousands of index entries. Raw storage is always validated.
export function normalizePersistedOutline(value: unknown): PersistedOutline | undefined {
  if (!record(value)) return
  if (verified.has(value)) return value as unknown as PersistedOutline
  if (value.format !== 1 || !string(value.directory, 4096) || !string(value.projectID, 256)
    || (value.revert !== undefined && !string(value.revert, 256))
    || !Array.isArray(value.entries) || value.entries.length > 200_000
    || !Array.isArray(value.checkpoints) || value.checkpoints.length > 512) return
  const entries: OutlineEntry[] = [], checkpoints: OutlineCheckpoint[] = []
  const ids = new Set<string>()
  let seq = -1, through = -1
  for (const entry of value.entries) {
    if (!record(entry) || !string(entry.id, 256) || ids.has(entry.id) || !integer(entry.seq) || entry.seq <= seq
      || typeof entry.type !== "string" || !types.has(entry.type) || !integer(entry.tools) || !integer(entry.reasoning)) return
    ids.add(entry.id); seq = entry.seq
    entries.push(Object.freeze({ id: entry.id, seq, type: entry.type as OutlineEntry["type"], tools: entry.tools, reasoning: entry.reasoning }))
  }
  for (const checkpoint of value.checkpoints) {
    if (!record(checkpoint) || checkpoint.after !== through || !integer(checkpoint.through) || checkpoint.through <= through
      || typeof checkpoint.digest !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.digest)) return
    checkpoints.push(Object.freeze({ after: through, through: checkpoint.through, digest: checkpoint.digest }))
    through = checkpoint.through
  }
  if (!checkpoints.length || seq > through) return
  const result: PersistedOutline = { format: 1, directory: value.directory, projectID: value.projectID,
    ...(value.revert === undefined ? {} : { revert: value.revert as string }), entries, checkpoints }
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
  if (bytes > 16 * 1024 * 1024) return
  Object.freeze(entries); Object.freeze(checkpoints); Object.freeze(result)
  verified.set(result, bytes)
  return result
}

export function normalizeOutlineIndexes(value: unknown, budget: OutlineBudget, priority?: string): Record<string, PersistedOutline> | undefined {
  if (!record(value)) return
  const result: Record<string, PersistedOutline> = Object.create(null)
  const keys = [priority, ...Object.keys(value).filter(id => id !== priority)].filter((id): id is string => Boolean(id))
  for (const id of keys) {
    if (!budget.indexes || !budget.entries || !budget.bytes) break
    if (!string(id, 256) || ["__proto__", "constructor", "prototype"].includes(id)) continue
    const index = normalizePersistedOutline(value[id])
    if (!index) continue
    const bytes = verified.get(index)!
    if (bytes > budget.bytes || index.entries.length > budget.entries) continue
    result[id] = index
    budget.bytes -= bytes; budget.entries -= index.entries.length; budget.indexes--
  }
  return Object.keys(result).length ? result : undefined
}
