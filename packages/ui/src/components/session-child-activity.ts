import { createMemo, untrack } from "solid-js"
import { createDeadlineMemo } from "../lib/deadline-memo"
import { sessionDescendants } from "../stores/session-projection"
import { countDescendantActivity, isSessionArchived, type DescendantActivity } from "../stores/session-tree"
import type { Session } from "../types/session"

export function createDescendantActivity(
  rows: () => ReadonlyMap<string, Session>,
  parentId: () => string | undefined,
  showIdle: (session: Session, now: number, wakeAt: (deadline: number) => void) => boolean,
) {
  const parent = createMemo(() => {
    const id = parentId()
    return id === undefined ? undefined : rows().get(id)
  })
  const archived = createMemo(() => {
    const row = parent()
    return row && isSessionArchived(row)
  })
  const family = createMemo(() => {
    const id = parent()?.id
    return id === undefined ? undefined : sessionDescendants(rows(), id)
  })
  return createDeadlineMemo((now, wakeAt) => {
    // The parent itself is outside the cached descendants, but can hide their idle badges.
    const parentArchived = archived(), descendants = family(), id = parentId()
    if (!descendants || id === undefined) return undefined
    return countDescendantActivity(untrack(rows), id, descendants,
      session => !parentArchived && showIdle(session, now, wakeAt))
  })
}

type Translate = (key: string, params?: Record<string, string>) => string

export type ChildActivityKind = "permission" | "working" | "compacting" | "idle"

/** The most urgent visible state among subsessions colours a collapsed parent's chevron. */
export function childActivityKind(activity: DescendantActivity): ChildActivityKind {
  return activity.permission ? "permission" : activity.working ? "working" : activity.compacting ? "compacting" : "idle"
}

/** Counted states, e.g. "1 subsession needs input, 2 subsessions working". */
export function childActivityLabel(t: Translate, activity: DescendantActivity): string {
  return (["permission", "working", "compacting", "idle"] as const)
    .filter((state) => activity[state] > 0)
    .map((state) => {
      const count = activity[state]
      return t(`sessionList.childActivity.${state}.${count === 1 ? "one" : "other"}`, { count: String(count) })
    })
    .join(", ")
}
