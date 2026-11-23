import type { Session } from "../types/session"
import type { SessionThread } from "./session-tree"

export type SessionRows = ReadonlyMap<string, Session>

type Projection = {
  topology: object
  children?: Map<string, string[]>
  families: Map<string, Session[]>
  checkpoint: object
  threads: Map<string, SessionThread>
  indicators?: Map<string, Session>
}

const indexes = new WeakMap<SessionRows, Projection>()

function index(rows: SessionRows): Projection {
  let entry = indexes.get(rows)
  if (!entry) indexes.set(rows, entry = { topology: {}, families: new Map(), checkpoint: {}, threads: new Map() })
  return entry
}

export const sessionTopology = (rows: SessionRows) => index(rows).topology
export const sessionCheckpoint = (rows: SessionRows) => index(rows).checkpoint
export const sessionThreadCache = (rows: SessionRows) => index(rows).threads

function hasSessionIndicator(row: Session): boolean {
  return row.status !== "idle" || typeof row.idleSince === "number" || !!row.pendingPermission || !!row.pendingForm
}

export function sessionIndicatorRows(rows: SessionRows): ReadonlyMap<string, Session> {
  const entry = index(rows)
  if (!entry.indicators) {
    entry.indicators = new Map()
    for (const row of rows.values()) if (hasSessionIndicator(row)) entry.indicators.set(row.id, row)
  }
  return entry.indicators
}

export function childSessionIds(rows: SessionRows, id: string): readonly string[] {
  const entry = index(rows)
  if (!entry.children) {
    entry.children = new Map()
    for (const row of rows.values()) {
      if (!row.parentId) continue
      const children = entry.children.get(row.parentId)
      if (children) children.push(row.id)
      else entry.children.set(row.parentId, [row.id])
    }
  }
  return entry.children.get(id) ?? []
}

export function sessionDescendants(rows: SessionRows, id: string): Session[] {
  const entry = index(rows)
  const cached = entry.families.get(id)
  if (cached) return cached
  const result: Session[] = []
  const seen = new Set([id])
  const queue = [...childSessionIds(rows, id)]
  for (let next = 0; next < queue.length; next++) {
    const childId = queue[next]!
    if (seen.has(childId)) continue
    seen.add(childId)
    const child = rows.get(childId)!
    result.push(child)
    for (const descendant of childSessionIds(rows, childId)) queue.push(descendant)
  }
  result.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  entry.families.set(id, result)
  return result
}

// Usage on a busy row is display data; it joins the next real checkpoint.
function sameCheckpoint(a: Session, b: Session): boolean {
  return a.status === b.status && a.title === b.title && a.parentId === b.parentId
    && a.projectID === b.projectID && a.location === b.location && a.time === b.time
    && a.agent === b.agent && a.model === b.model && a.subpath === b.subpath
    && a.idleSince === b.idleSince && a.generationRecovery === b.generationRecovery
    && a.runtimeStatusKnown === b.runtimeStatusKnown && a.outcome === b.outcome
    && a.pendingPermission === b.pendingPermission && a.pendingForm === b.pendingForm && a.retry === b.retry
    && (b.status !== "idle" || a.cost === b.cost && a.tokens === b.tokens)
}

export function carrySessionProjection(previous: SessionRows, next: SessionRows, before: Session | undefined, after: Session): void {
  const previousIndex = index(previous)
  const sameTopology = before !== undefined && before.parentId === after.parentId
    && before.location?.directory === after.location?.directory && before.location?.workspaceID === after.location?.workspaceID
    && before.projectID === after.projectID && before.subpath === after.subpath
  // An unreferenced child can only affect its ancestors. An insertion that
  // attaches existing orphans instead needs a new index and scope projection.
  const leaf = !before && after.parentId && !childSessionIds(previous, after.id).length
  const reuse = sameTopology || leaf
  // Move the derived caches to the new snapshot. A retained old snapshot can
  // still recreate its own caches from its immutable rows.
  const families = reuse ? previousIndex.families : new Map<string, Session[]>()
  const threads = reuse ? previousIndex.threads : new Map<string, SessionThread>()
  if (reuse) {
    previousIndex.families = new Map()
    previousIndex.threads = new Map()
  }
  let current: string | null = after.id
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current !== after.id) families.delete(current)
    threads.delete(current)
    current = (current === after.id ? after : previous.get(current))?.parentId ?? null
  }
  let indicators = previousIndex.indicators
  if (indicators && (indicators.has(after.id) || hasSessionIndicator(after))) {
    indicators = new Map(indicators)
    if (hasSessionIndicator(after)) indicators.set(after.id, after)
    else indicators.delete(after.id)
  }
  const children = sameTopology ? previousIndex.children
    : leaf && after.parentId ? new Map(previousIndex.children).set(after.parentId, [...childSessionIds(previous, after.parentId), after.id])
    : undefined
  indexes.set(next, {
    topology: sameTopology ? previousIndex.topology : {},
    children,
    families,
    checkpoint: before && sameCheckpoint(before, after) ? previousIndex.checkpoint : {},
    threads,
    indicators,
  })
}
