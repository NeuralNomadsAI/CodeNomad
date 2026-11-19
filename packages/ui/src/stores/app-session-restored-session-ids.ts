import { isLocalDraftId } from "./local-draft-ids"

export function getRestoredSessionIds(groups: Iterable<string>[]): string[] {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const id of group) {
      if (id && id !== "info" && !isLocalDraftId(id)) ids.add(id)
    }
  }
  return [...ids]
}
