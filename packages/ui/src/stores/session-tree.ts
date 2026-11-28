import type { Session } from "../types/session"
import { normalizeSessionDirectory } from "./session-list-options"
import { childSessionIds, sessionDescendants, sessionThreadCache } from "./session-projection"
import { isReservedMissionScheduleSessionID } from "../../../server/src/missions/mission-schedule-carrier-identity"

export type SessionThread = {
  session: Session
  children: SessionThread[]
  depth: number
  hasChildren: boolean
  latestUpdated: number
}

export type VisibleSessionRow = {
  sessionId: string
  thread: SessionThread
  depth: number
  isLastChild: boolean
  hasChildren: boolean
  expanded: boolean
}

export type SessionFamilySort = "activity" | "name" | "worktree"
export type SessionArchiveFilter = "active" | "archived" | "all"

export const isSessionArchived = (session: Session): boolean => session.time.archived !== undefined

type ArchiveProjection = { thread: SessionThread; live: boolean }
const archiveProjections = new WeakMap<SessionThread, { selected?: string | null; inherited: boolean; result: ArchiveProjection | null }>()
const stableThreads = new WeakSet<SessionThread>()

/** Hide archived branches, retaining the selected conversation and live work or
 * pending requests with their ancestor path. Native child flags stay unchanged. */
export function projectUnarchivedSessionThreads(threads: SessionThread[], selected?: string | null): SessionThread[] {
  const visit = (thread: SessionThread, inherited = false): ArchiveProjection | null => {
    const cached = archiveProjections.get(thread)
    if (cached?.selected === selected && cached?.inherited === inherited) return cached.result
    const archived = inherited || isSessionArchived(thread.session)
    const children = thread.children.flatMap(child => {
      const result = visit(child, archived)
      return result ? [result] : []
    })
    const session = thread.session
    const live = session.id === selected || session.status === "working" || session.status === "compacting" || Boolean(session.pendingPermission || session.pendingForm)
      || children.some(child => child.live)
    const projected = children.map(child => child.thread)
    const result = archived && !live ? null : { live,
      thread: projected.length === thread.children.length && projected.every((child, index) => child === thread.children[index])
        ? thread
        : { ...thread, children: projected, hasChildren: projected.length > 0,
          latestUpdated: projected.reduce((latest, child) => Math.max(latest, child.latestUpdated), session.time.updated) },
    }
    if (stableThreads.has(thread)) {
      archiveProjections.set(thread, { selected, inherited, result })
      if (result) stableThreads.add(result.thread)
    }
    return result
  }
  const visible: SessionThread[] = []
  for (const thread of threads) {
    const result = visit(thread)
    if (result) visible.push(result.thread)
  }
  return visible
}

type SessionFamilyProjection = {
  matchesSession?: (session: Session) => boolean
  worktreeDirectory?: string
  sort: SessionFamilySort
  getWorktreeLabel: (directory: string) => string
  favoriteIds?: ReadonlySet<string>
}

// Pending requests bring their branch forward; favorites rank only their own row.
type PrioritizedThread = { favoriteIds: ReadonlySet<string>; row: SessionThread; rank: number }
const prioritizedThreads = new WeakMap<SessionThread, PrioritizedThread>()
function prioritizeActivity(threads: SessionThread[], favoriteIds: ReadonlySet<string>): SessionThread[] {
  const visit = (thread: SessionThread): PrioritizedThread => {
    const cached = prioritizedThreads.get(thread)
    if (cached?.favoriteIds === favoriteIds) return cached
    const ranked = thread.children.map(visit).sort((a, b) => b.rank - a.rank)
    const children = ranked.map(child => child.row)
    const row = children.every((child, i) => child === thread.children[i]) ? thread : { ...thread, children }
    const own = thread.session.pendingPermission || thread.session.pendingForm ? 2 : favoriteIds.has(thread.session.id) ? 1 : 0
    const result = { row, favoriteIds, rank: ranked.some(child => child.rank === 2) ? 2 : own }
    if (stableThreads.has(thread)) prioritizedThreads.set(thread, result)
    return result
  }
  return threads.map(visit).sort((a, b) => b.rank - a.rank).map(thread => thread.row)
}

function someSession(thread: SessionThread, predicate: (session: Session) => boolean): boolean {
  return predicate(thread.session) || thread.children.some((child) => someSession(child, predicate))
}

export function projectSessionFamilies(
  threads: SessionThread[],
  options: SessionFamilyProjection,
): SessionThread[] {
  const worktreeDirectory = normalizeSessionDirectory(options.worktreeDirectory)
  const projected = threads.filter((thread) => {
    if (isReservedMissionScheduleSessionID(thread.session.id)) return false
    if (options.matchesSession && !someSession(thread, options.matchesSession)) return false
    if (!worktreeDirectory) return true
    return someSession(thread, (session) => normalizeSessionDirectory(session.location?.directory) === worktreeDirectory)
  })

  projected.sort((left, right) => {
    if (options.sort === "activity") {
      return right.latestUpdated - left.latestUpdated || right.session.id.localeCompare(left.session.id)
    }
    if (options.sort === "name") {
      return (left.session.title ?? "").localeCompare(right.session.title ?? "") || left.session.id.localeCompare(right.session.id)
    }
    const leftLabel = options.getWorktreeLabel(left.session.location?.directory ?? "")
    const rightLabel = options.getWorktreeLabel(right.session.location?.directory ?? "")
    return leftLabel.localeCompare(rightLabel) || (left.session.title ?? "").localeCompare(right.session.title ?? "")
  })
  return options.sort === "activity" && options.favoriteIds ? prioritizeActivity(projected, options.favoriteIds) : projected
}

// Search rows are independent leaves: filtering, sorting and selection all use
// the session itself, without adding ancestors or inheriting descendant activity.
export function projectSessionSearchResults(
  sessions: Iterable<Session>,
  options: SessionFamilyProjection & { includeMainSessions: boolean; includeSubsessions: boolean; archive?: SessionArchiveFilter },
): SessionThread[] {
  const rows = new Map<string, SessionThread>()
  for (const session of sessions) {
    if (isReservedMissionScheduleSessionID(session.id)) continue
    if ((options.archive ?? "active") !== "all" && isSessionArchived(session) !== (options.archive === "archived")) continue
    if (session.parentId && !options.includeSubsessions) continue
    if (!session.parentId && !options.includeMainSessions) continue
    rows.set(session.id, { session, children: [], depth: 0, hasChildren: false, latestUpdated: session.time.updated })
  }
  return projectSessionFamilies([...rows.values()], options)
}

export function getSessionRootFromMap(instanceSessions: ReadonlyMap<string, Session>, sessionId: string, directoryOnly?: string): Session | null {
  let current = instanceSessions.get(sessionId)
  if (!current) return null
  const inScope = (session: Session) => !directoryOnly || normalizeSessionDirectory(session.location.directory) === normalizeSessionDirectory(directoryOnly)
  if (!inScope(current)) return null
  if (!current.parentId) return current

  const seen = new Set<string>()
  while (current.parentId) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    const parent = instanceSessions.get(current.parentId)
    if (!parent || !inScope(parent)) return directoryOnly ? current : null
    current = parent
  }
  return current
}

export function getSessionAncestorIdsFromMap(instanceSessions: ReadonlyMap<string, Session>, sessionId: string): string[] {
  const ancestors: string[] = []
  const seen = new Set<string>([sessionId])
  let current = instanceSessions.get(sessionId)
  while (current?.parentId) {
    if (seen.has(current.parentId)) return []
    seen.add(current.parentId)
    const parent = instanceSessions.get(current.parentId)
    if (!parent) return []
    ancestors.push(parent.id)
    current = parent
  }
  ancestors.reverse()
  return ancestors
}

export type DescendantActivity = { permission: number; working: number; compacting: number; idle: number }

export function countDescendantActivity(
  rows: ReadonlyMap<string, Session>,
  parentId: string,
  descendants: readonly Session[],
  showIdleStatus: (session: Session) => boolean,
): DescendantActivity | undefined {
  let activity: DescendantActivity | undefined
  for (const session of descendants) {
    const kind = session.pendingPermission || session.pendingForm ? "permission"
      : session.status !== "idle" ? session.status : showIdleStatus(session) ? "idle" : null
    if (!kind) continue
    if (kind === "idle") {
      let ancestor: Session | undefined = session
      while (ancestor && !isSessionArchived(ancestor) && ancestor.id !== parentId) {
        ancestor = ancestor.parentId ? rows.get(ancestor.parentId) : undefined
      }
      if (ancestor?.id !== parentId || isSessionArchived(ancestor)) continue
    }
    activity ??= { permission: 0, working: 0, compacting: 0, idle: 0 }
    activity[kind]++
  }
  return activity
}

export function getDescendantSessionsFromMap(instanceSessions: Map<string, Session>, parentId: string): Session[] {
  return sessionDescendants(instanceSessions, parentId)
}

function buildThread(
  session: Session,
  childrenFor: (id: string) => Iterable<Session>,
  depth: number,
  ancestorIds: Set<string>,
  cache?: Map<string, SessionThread>,
): SessionThread | null {
  if (ancestorIds.has(session.id) || isReservedMissionScheduleSessionID(session.id)) return null
  const cached = cache?.get(session.id)
  if (cached?.depth === depth) return cached
  ancestorIds.add(session.id)

  const children: SessionThread[] = []
  try {
    for (const child of childrenFor(session.id)) {
      const childThread = buildThread(child, childrenFor, depth + 1, ancestorIds, cache)
      if (childThread) children.push(childThread)
    }
  } finally {
    ancestorIds.delete(session.id)
  }
  children.sort((a, b) => {
    if (b.latestUpdated !== a.latestUpdated) return b.latestUpdated - a.latestUpdated
    return b.session.id.localeCompare(a.session.id)
  })

  let latestUpdated = session.time.updated ?? 0
  for (const child of children) latestUpdated = Math.max(latestUpdated, child.latestUpdated)
  const thread = { session, children, depth, hasChildren: children.length > 0, latestUpdated }
  if (cache) {
    cache.set(session.id, thread)
    stableThreads.add(thread)
  }
  return thread
}

export function buildSessionThreadsFromMap(
  instanceSessions: ReadonlyMap<string, Session>,
  rootIds: string[],
  includedDescendantIds?: Set<string>,
  directoryOnly?: string,
  stable = false,
): SessionThread[] {
  let includedIds: Set<string> | null = null
  if (includedDescendantIds) {
    includedIds = new Set(rootIds)
    for (const sessionId of includedDescendantIds) {
      includedIds.add(sessionId)
      for (const ancestorId of getSessionAncestorIdsFromMap(instanceSessions, sessionId)) includedIds.add(ancestorId)
    }
  }

  const directory = normalizeSessionDirectory(directoryOnly)
  function* childrenFor(id: string) {
    for (const childId of childSessionIds(instanceSessions, id)) {
      if (includedIds && !includedIds.has(childId)) continue
      const session = instanceSessions.get(childId)!
      if (!directory || normalizeSessionDirectory(session.location.directory) === directory) yield session
    }
  }
  const cache = stable && !includedIds && !directoryOnly ? sessionThreadCache(instanceSessions) : undefined

  const threads: SessionThread[] = []
  const seenRootIds = new Set<string>()
  const ancestorIds = new Set<string>()
  for (const rootId of rootIds) {
    if (seenRootIds.has(rootId)) continue
    seenRootIds.add(rootId)
    const root = instanceSessions.get(rootId)
    if (!root || getSessionRootFromMap(instanceSessions, root.id, directoryOnly)?.id !== root.id) continue
    const thread = buildThread(root, childrenFor, 0, ancestorIds, cache)
    if (thread) threads.push(thread)
  }
  threads.sort((a, b) => {
    if (b.latestUpdated !== a.latestUpdated) return b.latestUpdated - a.latestUpdated
    const updatedDelta = (b.session.time.updated ?? 0) - (a.session.time.updated ?? 0)
    return updatedDelta || b.session.id.localeCompare(a.session.id)
  })
  return threads
}

export function collectVisibleSessionIds(threads: SessionThread[], expanded: Set<string> | undefined): string[] {
  const ids: string[] = []
  for (const thread of threads) {
    ids.push(thread.session.id)
    if (expanded?.has(thread.session.id)) ids.push(...collectVisibleSessionIds(thread.children, expanded))
  }
  return ids
}

export function flattenVisibleSessionThreads(
  threads: readonly SessionThread[],
  isExpanded: (sessionId: string) => boolean,
): VisibleSessionRow[] {
  const rows: VisibleSessionRow[] = []

  const append = (siblings: readonly SessionThread[], depth: number) => {
    siblings.forEach((thread, index) => {
      const hasChildren = thread.children.length > 0
      const expanded = hasChildren && isExpanded(thread.session.id)
      rows.push({
        sessionId: thread.session.id,
        thread,
        depth,
        isLastChild: index === siblings.length - 1,
        hasChildren,
        expanded,
      })
      if (expanded) append(thread.children, depth + 1)
    })
  }

  append(threads, 0)
  return rows
}

export function findSessionThread(threads: SessionThread[], sessionId: string): SessionThread | null {
  for (const thread of threads) {
    if (thread.session.id === sessionId) return thread
    const child = findSessionThread(thread.children, sessionId)
    if (child) return child
  }
  return null
}

export function collectSessionThreadIds(threads: SessionThread[]): string[] {
  const ids: string[] = []
  const visit = (list: SessionThread[]) => {
    for (const thread of list) {
      ids.push(thread.session.id)
      if (thread.children.length > 0) visit(thread.children)
    }
  }
  visit(threads)
  return ids
}

export function sortSessionIdsDeepestFirst(instanceSessions: Map<string, Session>, sessionIds: string[]): string[] {
  return [...sessionIds].sort(
    (left, right) => getSessionAncestorIdsFromMap(instanceSessions, right).length - getSessionAncestorIdsFromMap(instanceSessions, left).length,
  )
}
