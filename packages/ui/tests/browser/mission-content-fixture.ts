import type { Page } from "playwright"
import type { MissionMap, MissionPanelMap } from "../../../server/src/api-types"
import { missionContentRequestSchema, readMissionContent } from "../../../server/src/missions/mission-content"
import { compactMissionMap } from "../../../server/src/missions/mission-compact-map"
import { isFullMissionMap } from "../../../server/src/missions/mission-panel-map"

/** The full maps `panelMissions` compacted last, one per mission. */
const listed = new Map<string, MissionMap>()

/** Maps as the list and mission reads return them: compact, a descriptor in place of each
 * body. The full maps are kept, the latest per mission, for `listedMissions`. */
export const panelMissions = (values: readonly (MissionMap | MissionPanelMap)[]) => values.map(value => {
  if (isFullMissionMap(value)) listed.set(value.id, value)
  return compactMissionMap(value)
})

/** The full maps of the latest list responses `panelMissions` built: a content route for
 * fixtures whose maps vary per test (`routeMissionContent(page, listedMissions)`). */
export const listedMissions = (): MissionMap[] => [...listed.values()]

/** The content route (`GET …/missions/:missionID/content`) answered from a fixture's full maps,
 * sliced exactly as the server slices them; undefined for any other path. */
export function missionContentFixture(url: string, method: string, values: readonly MissionMap[], projectID = "project") {
  const parsed = new URL(url), match = /\/missions\/([^/]+)\/content$/.exec(parsed.pathname)
  if (!match || method !== "GET") return undefined
  const query: Record<string, unknown> = Object.fromEntries(parsed.searchParams)
  for (const key of ["offset", "change"]) if (typeof query[key] === "string") query[key] = Number(query[key])
  const request = missionContentRequestSchema.safeParse({ ...query, missionID: decodeURIComponent(match[1]) })
  if (!request.success) return { error: "Invalid mission content request" }
  const mission = values.find(value => value.id === request.data.missionID)
  return { available: true, ...readMissionContent(mission?.projectID ?? projectID, request.data, mission) }
}

export const isMissionContentRequest = (url: string) => /\/missions\/[^/]+\/content$/.test(new URL(url).pathname)

/** Serves the content route on `page` from `values()`, the fixture's full maps (registered
 * last, so it answers first). */
export async function routeMissionContent(page: Page, values: () => readonly MissionMap[], projectID = "project") {
  await page.route("**/missions/*/content**", route => {
    const request = route.request(), json = missionContentFixture(request.url(), request.method(), values(), projectID)
    return json ? route.fulfill({ json }) : route.fallback()
  })
}
