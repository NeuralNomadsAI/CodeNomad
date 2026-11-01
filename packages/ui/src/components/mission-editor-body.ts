import type { MissionPanelMap } from "../../../server/src/api-types"
import { isFullMissionMap } from "../../../server/src/missions/mission-panel-map"
import { missionBodyDescriptor, type MissionContentResponse, type MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { validMissionContentSlice } from "../lib/mission-content-slice"

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
    if (!response.available || !("content" in response) || response.version !== 1 || response.projectID !== mission.projectID || response.missionID !== mission.id) {
      throw new Error("Mission body unavailable")
    }
    const slice = validMissionContentSlice(selector, { offset, digest: expected.digest }, response.content)
    if (slice.characters !== expected.characters
      || offset > 0 && json !== (slice.json === true)) throw new Error("Mission body changed")
    json = slice.json === true; text += slice.text
    if (slice.next === undefined) return json ? JSON.parse(text) : text
    offset = slice.next
  } while (true)
}
