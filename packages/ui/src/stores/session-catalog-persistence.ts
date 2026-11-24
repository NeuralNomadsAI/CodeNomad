import type { Session } from "../types/session"

// Display metadata only: no messages, runtime permissions or execution authority.
export type PersistedSessionCatalogEntry = Pick<Session,
  "id" | "title" | "parentId" | "projectID" | "location" | "time" | "agent" | "model" | "cost" | "tokens" | "subpath">

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max
const id = (value: unknown): value is string => text(value, 512) && value.trim().length > 0
  && !["__proto__", "constructor", "prototype"].includes(value)
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

const normalizedCatalogs = new WeakSet<PersistedSessionCatalogEntry[]>()
const normalizedRows = new WeakSet<PersistedSessionCatalogEntry>()

export function normalizeSessionCatalog(value: unknown): PersistedSessionCatalogEntry[] | undefined {
  return normalizeCatalog(value)
}

function normalizeCatalog(value: unknown, previous?: readonly PersistedSessionCatalogEntry[]): PersistedSessionCatalogEntry[] | undefined {
  if (!Array.isArray(value)) return
  if (normalizedCatalogs.has(value)) return value
  const result: PersistedSessionCatalogEntry[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!record(row) || !id(row.id) || seen.has(row.id)) return
    seen.add(row.id)
    if (normalizedRows.has(row as PersistedSessionCatalogEntry)) {
      result.push(row as PersistedSessionCatalogEntry)
      continue
    }
    const old = previous?.[result.length]
    // Live rows (including nested fields) can mutate in place. Compare their
    // persisted scalars against our own immutable copy before reusing it.
    if (old && sameCatalogRow(old, row)) {
      result.push(old)
      continue
    }
    if (!text(row.title, 32768)
      || !(row.parentId === null || id(row.parentId)) || !text(row.projectID, 512)
      || !record(row.location) || !text(row.location.directory, 4096) || !row.location.directory
      || !(row.location.workspaceID === undefined || text(row.location.workspaceID, 512))
      || !record(row.time) || !number(row.time.created) || !number(row.time.updated)
      || !(row.time.archived === undefined || number(row.time.archived))
      || !text(row.agent, 512) || !record(row.model) || !text(row.model.providerId, 512) || !text(row.model.modelId, 512)
      || !number(row.cost) || !record(row.tokens) || !record(row.tokens.cache)
      || ![row.tokens.input, row.tokens.output, row.tokens.reasoning, row.tokens.cache.read, row.tokens.cache.write].every(number)
      || !(row.subpath === undefined || text(row.subpath, 4096))) return
    const normalized: PersistedSessionCatalogEntry = {
      id: row.id, title: row.title, parentId: row.parentId, projectID: row.projectID,
      location: { directory: row.location.directory,
        ...(row.location.workspaceID === undefined ? {} : { workspaceID: row.location.workspaceID }) },
      time: { created: row.time.created, updated: row.time.updated,
        ...(row.time.archived === undefined ? {} : { archived: row.time.archived }) },
      agent: row.agent, model: { providerId: row.model.providerId, modelId: row.model.modelId }, cost: row.cost,
      tokens: { input: row.tokens.input as number, output: row.tokens.output as number, reasoning: row.tokens.reasoning as number,
        cache: { read: row.tokens.cache.read as number, write: row.tokens.cache.write as number } },
      ...(row.subpath === undefined ? {} : { subpath: row.subpath }),
    }
    Object.freeze(normalized.location); Object.freeze(normalized.time); Object.freeze(normalized.model)
    Object.freeze(normalized.tokens.cache); Object.freeze(normalized.tokens)
    Object.freeze(normalized)
    normalizedRows.add(normalized)
    result.push(normalized)
  }
  if (previous?.length === result.length && result.every((row, index) => row === previous[index])) {
    return previous as PersistedSessionCatalogEntry[]
  }
  Object.freeze(result)
  normalizedCatalogs.add(result)
  return result
}

function sameCatalogRow(old: PersistedSessionCatalogEntry, row: Record<string, unknown>): boolean {
  return old.id === row.id && old.title === row.title && old.parentId === row.parentId && old.projectID === row.projectID
    && old.agent === row.agent && old.cost === row.cost && old.subpath === row.subpath
    && record(row.location) && old.location.directory === row.location.directory && old.location.workspaceID === row.location.workspaceID
    && record(row.time) && old.time.created === row.time.created && old.time.updated === row.time.updated && old.time.archived === row.time.archived
    && record(row.model) && old.model.providerId === row.model.providerId && old.model.modelId === row.model.modelId
    && record(row.tokens) && old.tokens.input === row.tokens.input && old.tokens.output === row.tokens.output
    && old.tokens.reasoning === row.tokens.reasoning && record(row.tokens.cache)
    && old.tokens.cache.read === row.tokens.cache.read && old.tokens.cache.write === row.tokens.cache.write
}

export function captureSessionCatalog(sessions: readonly Session[], owner?: object): PersistedSessionCatalogEntry[] | undefined {
  const catalog = normalizeCatalog(sessions, owner && captured.get(owner))
  if (owner) {
    if (catalog) captured.set(owner, catalog)
    else captured.delete(owner)
  }
  return catalog
}

const captured = new WeakMap<object, PersistedSessionCatalogEntry[]>()
