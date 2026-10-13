import type { DescendantActivity } from "../stores/session-tree"

type Translate = (key: string, params?: Record<string, string>) => string

export type ChildActivityKind = "permission" | "working" | "compacting"

/** The most urgent state among busy subsessions colours a collapsed parent's chevron. */
export function childActivityKind(activity: DescendantActivity): ChildActivityKind {
  return activity.permission ? "permission" : activity.working ? "working" : "compacting"
}

/** Counted states, e.g. "1 subsession needs input, 2 subsessions working". */
export function childActivityLabel(t: Translate, activity: DescendantActivity): string {
  return (["permission", "working", "compacting"] as const)
    .filter((state) => activity[state] > 0)
    .map((state) => {
      const count = activity[state]
      return t(`sessionList.childActivity.${state}.${count === 1 ? "one" : "other"}`, { count: String(count) })
    })
    .join(", ")
}
