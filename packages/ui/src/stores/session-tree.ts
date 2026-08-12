import type { Session } from "../types/session"

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

export type SessionThreadSortMode = "activity" | "name" | "worktree"

export function projectSessionThreads(
  threads: readonly SessionThread[],
  options: {
    sort: SessionThreadSortMode
    worktree: string | null
    getLabel: (thread: SessionThread) => string
    getWorktree: (thread: SessionThread) => string
  },
): SessionThread[] {
  const projected = options.worktree
    ? threads.filter((thread) => options.getWorktree(thread) === options.worktree)
    : [...threads]
  if (options.sort === "activity") return projected

  return projected.sort((left, right) => {
    const primary = options.sort === "name"
      ? options.getLabel(left).localeCompare(options.getLabel(right), undefined, { sensitivity: "base" })
      : options.getWorktree(left).localeCompare(options.getWorktree(right), undefined, { sensitivity: "base" })
    return primary || right.latestUpdated - left.latestUpdated || right.session.id.localeCompare(left.session.id)
  })
}

export function getSessionRootFromMap(instanceSessions: Map<string, Session>, sessionId: string): Session | null {
  let current = instanceSessions.get(sessionId)
  if (!current) return null

  const seen = new Set<string>()
  while (current.parentId) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    const parent = instanceSessions.get(current.parentId)
    if (!parent) return null
    current = parent
  }
  return current
}

export function getSessionAncestorIdsFromMap(instanceSessions: Map<string, Session>, sessionId: string): string[] {
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

export function getDescendantSessionsFromMap(instanceSessions: Map<string, Session>, parentId: string): Session[] {
  const childrenByParent = new Map<string, Session[]>()
  for (const session of instanceSessions.values()) {
    if (!session.parentId) continue
    const children = childrenByParent.get(session.parentId)
    if (children) children.push(session)
    else childrenByParent.set(session.parentId, [session])
  }

  const descendants: Session[] = []
  const queue = [...(childrenByParent.get(parentId) ?? [])]
  const seen = new Set<string>([parentId])
  while (queue.length > 0) {
    const session = queue.shift()
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    descendants.push(session)
    queue.push(...(childrenByParent.get(session.id) ?? []))
  }
  descendants.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  return descendants
}

function buildThread(
  session: Session,
  childrenByParent: Map<string, Session[]>,
  depth: number,
  ancestorIds: Set<string>,
): SessionThread | null {
  if (ancestorIds.has(session.id)) return null
  const nextAncestorIds = new Set(ancestorIds)
  nextAncestorIds.add(session.id)

  const children: SessionThread[] = []
  for (const child of childrenByParent.get(session.id) ?? []) {
    const childThread = buildThread(child, childrenByParent, depth + 1, nextAncestorIds)
    if (childThread) children.push(childThread)
  }
  children.sort((a, b) => {
    if (b.latestUpdated !== a.latestUpdated) return b.latestUpdated - a.latestUpdated
    return b.session.id.localeCompare(a.session.id)
  })

  let latestUpdated = session.time.updated ?? 0
  for (const child of children) latestUpdated = Math.max(latestUpdated, child.latestUpdated)
  return { session, children, depth, hasChildren: children.length > 0, latestUpdated }
}

export function buildSessionThreadsFromMap(
  instanceSessions: Map<string, Session>,
  rootIds: string[],
  includedDescendantIds?: Set<string>,
): SessionThread[] {
  let includedIds: Set<string> | null = null
  if (includedDescendantIds) {
    includedIds = new Set(rootIds)
    for (const sessionId of includedDescendantIds) {
      includedIds.add(sessionId)
      for (const ancestorId of getSessionAncestorIdsFromMap(instanceSessions, sessionId)) includedIds.add(ancestorId)
    }
  }

  const childrenByParent = new Map<string, Session[]>()
  for (const session of instanceSessions.values()) {
    if (!session.parentId || (includedIds && !includedIds.has(session.id))) continue
    const children = childrenByParent.get(session.parentId)
    if (children) children.push(session)
    else childrenByParent.set(session.parentId, [session])
  }

  const threads: SessionThread[] = []
  const seenRootIds = new Set<string>()
  for (const rootId of rootIds) {
    if (seenRootIds.has(rootId)) continue
    seenRootIds.add(rootId)
    const root = instanceSessions.get(rootId)
    if (!root || root.parentId !== null) continue
    const thread = buildThread(root, childrenByParent, 0, new Set())
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
  for (const thread of threads) {
    ids.push(thread.session.id)
    ids.push(...collectSessionThreadIds(thread.children))
  }
  return ids
}

export function sortSessionIdsDeepestFirst(instanceSessions: Map<string, Session>, sessionIds: string[]): string[] {
  return [...sessionIds].sort(
    (left, right) => getSessionAncestorIdsFromMap(instanceSessions, right).length - getSessionAncestorIdsFromMap(instanceSessions, left).length,
  )
}
