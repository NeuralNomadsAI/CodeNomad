import type { SessionThread } from "../stores/session-state"

type Projection = { getIds: () => readonly string[] }

const projections = new Map<string, Projection>()

export function registerSessionListProjection(instanceId: string, getIds: Projection["getIds"]): () => void {
  const projection = { getIds }
  projections.set(instanceId, projection)
  return () => {
    if (projections.get(instanceId) === projection) projections.delete(instanceId)
  }
}

export function getSessionListProjectionIds(instanceId: string, fallback: () => readonly string[]): readonly string[] {
  return projections.get(instanceId)?.getIds() ?? fallback()
}

export function filterSessionThreads(
  threads: readonly SessionThread[],
  query: string,
  getLabel: (thread: SessionThread) => string,
): SessionThread[] {
  if (!query) return [...threads]
  const filter = (thread: SessionThread): SessionThread | null => {
    const children = thread.children.map(filter).filter((child): child is SessionThread => child !== null)
    const matches = getLabel(thread).toLowerCase().includes(query) || thread.session.id.toLowerCase().includes(query)
    return matches || children.length ? { ...thread, children } : null
  }
  return threads.map(filter).filter((thread): thread is SessionThread => thread !== null)
}

export function getSessionDeletionFallback(
  ids: readonly string[],
  activeId: string,
  deletedIds: ReadonlySet<string>,
): string | undefined {
  const activeIndex = ids.indexOf(activeId)
  if (activeIndex === -1) return undefined
  for (let index = activeIndex + 1; index < ids.length; index += 1) {
    const candidate = ids[index]
    if (candidate && !deletedIds.has(candidate)) return candidate
  }
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const candidate = ids[index]
    if (candidate && !deletedIds.has(candidate)) return candidate
  }
  return undefined
}
