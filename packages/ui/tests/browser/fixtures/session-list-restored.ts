import { setLoading } from "../../../src/stores/session-state"

/** Fixtures without a real session-list read settle (or start) its restoration
 * explicitly; Missions display demand waits for it. */
export function setSessionListFetching(fetching: boolean, ...instanceIds: string[]): void {
  setLoading(previous => {
    const fetchingSessions = new Map(previous.fetchingSessions)
    for (const id of instanceIds) fetchingSessions.set(id, fetching)
    return { ...previous, fetchingSessions }
  })
}

export const markSessionListsRestored = (...instanceIds: string[]) => setSessionListFetching(false, ...instanceIds)
