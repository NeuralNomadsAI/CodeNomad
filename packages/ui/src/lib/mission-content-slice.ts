import type { MissionContentSelector, MissionContentSlice } from "../../../server/src/missions/mission-content-wire"

/** Validate wire slices independently of either display caching or editor receipt reads. */
export function validMissionContentSlice(selector: MissionContentSelector, query: { digest?: string; offset: number },
  slice: MissionContentSlice | undefined): MissionContentSlice {
  if (!slice || typeof slice.text !== "string" || typeof slice.digest !== "string"
    || slice.kind !== selector.kind || slice.field !== selector.field
    || slice.taskKey !== ("taskKey" in selector ? selector.taskKey : undefined)
    || slice.reportId !== ("reportId" in selector ? selector.reportId : undefined)
    || slice.change !== ("change" in selector ? selector.change : undefined)
    || slice.offset !== query.offset || query.digest !== undefined && slice.digest !== query.digest
    || !Number.isSafeInteger(slice.characters) || slice.characters < 0
    || !Number.isSafeInteger(slice.offset) || slice.offset < 0 || slice.offset + slice.text.length > slice.characters
    || (slice.next === undefined ? slice.offset + slice.text.length !== slice.characters
      : slice.next !== slice.offset + slice.text.length || slice.next >= slice.characters || !slice.text.length)) throw new Error("Invalid mission content slice")
  return slice
}
