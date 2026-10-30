import type { MissionPanelMap } from "../../../server/src/api-types"
import { isFullMissionMap } from "../../../server/src/missions/mission-panel-map"
import { missionBodyDescriptor, type MissionContentResponse, type MissionContentSelector } from "../../../server/src/missions/mission-content-wire"

type Selector = Extract<MissionContentSelector, { kind: "mission" | "change" }>

/** Read exactly the body named by this display snapshot, including all its slices.
 * Maps without descriptors retain the older plugin's inline value. */
export async function readMissionEditorBody(mission: MissionPanelMap, selector: Selector,
  fetch: (query: Selector & { offset: number; digest: string }) => Promise<MissionContentResponse>): Promise<unknown> {
  const owner = selector.kind === "mission" ? mission : mission.history.find(change => change.revision === selector.change)
  const expected = missionBodyDescriptor(mission, selector)
  if (!expected) return owner?.bodies || !isFullMissionMap(mission) ? undefined : (owner as unknown as Record<string, unknown> | undefined)?.[selector.field]
  let offset = 0, text = "", json = false
  do {
    const response = await fetch({ ...selector, offset, digest: expected.digest })
    if (!response.available || !("content" in response) || response.projectID !== mission.projectID || response.missionID !== mission.id) {
      throw new Error("Mission body unavailable")
    }
    const slice = response.content
    if (slice.kind !== selector.kind || slice.field !== selector.field || selector.kind === "change" && slice.change !== selector.change
      || slice.digest !== expected.digest || slice.characters !== expected.characters || slice.offset !== offset
      || typeof slice.text !== "string" || offset + slice.text.length !== (slice.next ?? slice.characters)
      || slice.next !== undefined && (slice.next <= offset || slice.next >= slice.characters)
      || offset > 0 && json !== (slice.json === true)) throw new Error("Mission body changed")
    json = slice.json === true; text += slice.text
    if (slice.next === undefined) return json ? JSON.parse(text) : text
    offset = slice.next
  } while (true)
}
