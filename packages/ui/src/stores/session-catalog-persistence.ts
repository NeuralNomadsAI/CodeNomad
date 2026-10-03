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

export function normalizeSessionCatalog(value: unknown): PersistedSessionCatalogEntry[] | undefined {
  if (!Array.isArray(value)) return
  const result: PersistedSessionCatalogEntry[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!record(row) || !id(row.id) || seen.has(row.id) || !text(row.title, 32768)
      || !(row.parentId === null || id(row.parentId)) || !text(row.projectID, 512)
      || !record(row.location) || !text(row.location.directory, 4096) || !row.location.directory
      || !(row.location.workspaceID === undefined || text(row.location.workspaceID, 512))
      || !record(row.time) || !number(row.time.created) || !number(row.time.updated)
      || !(row.time.archived === undefined || number(row.time.archived))
      || !text(row.agent, 512) || !record(row.model) || !text(row.model.providerId, 512) || !text(row.model.modelId, 512)
      || !number(row.cost) || !record(row.tokens) || !record(row.tokens.cache)
      || ![row.tokens.input, row.tokens.output, row.tokens.reasoning, row.tokens.cache.read, row.tokens.cache.write].every(number)
      || !(row.subpath === undefined || text(row.subpath, 4096))) return
    seen.add(row.id)
    result.push({
      id: row.id, title: row.title, parentId: row.parentId, projectID: row.projectID,
      location: { directory: row.location.directory,
        ...(row.location.workspaceID === undefined ? {} : { workspaceID: row.location.workspaceID }) },
      time: { created: row.time.created, updated: row.time.updated,
        ...(row.time.archived === undefined ? {} : { archived: row.time.archived }) },
      agent: row.agent, model: { providerId: row.model.providerId, modelId: row.model.modelId }, cost: row.cost,
      tokens: { input: row.tokens.input as number, output: row.tokens.output as number, reasoning: row.tokens.reasoning as number,
        cache: { read: row.tokens.cache.read as number, write: row.tokens.cache.write as number } },
      ...(row.subpath === undefined ? {} : { subpath: row.subpath }),
    })
  }
  return result
}

export function captureSessionCatalog(sessions: readonly Session[]): PersistedSessionCatalogEntry[] | undefined {
  return normalizeSessionCatalog(sessions)
}
