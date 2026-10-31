import type { Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import { missionContentRequestSchema, readMissionContent } from "../../../server/src/missions/mission-content"
import { describeMissionBodies } from "../../../server/src/missions/mission-body-descriptors"

/** Maps as the plugin's list and mission reads return them, with their body descriptors. */
export const describedMissions = (values: readonly MissionMap[]) => values.map(describeMissionBodies)

/** The content route (`GET …/missions/:missionID/content`) answered from a fixture's maps,
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

/** Serves the content route on `page` from `values()` (registered last, so it answers first). */
export async function routeMissionContent(page: Page, values: () => readonly MissionMap[], projectID = "project") {
  await page.route("**/missions/*/content**", route => {
    const request = route.request(), json = missionContentFixture(request.url(), request.method(), values(), projectID)
    return json ? route.fulfill({ json }) : route.fallback()
  })
}

/** Serves the content route on `page` from the maps its own mission reads returned (the
 * latest list, then single-mission reads), as the server that sent them holds them. Register
 * it after a catch-all `**\/api/**` route; a later `…/missions**` handler passes content reads
 * on with `route.fallback()` when `isMissionContentRequest`. */
export async function serveMissionContent(page: Page, projectID = "project") {
  let maps = new Map<string, MissionMap>(), latest = Promise.resolve()
  page.on("response", response => {
    const path = new URL(response.url()).pathname
    const list = /\/missions$/.test(path), single = /\/missions\/(?!recurrence$)[^/]+(?:\/admission)?$/.test(path)
    if (response.request().method() !== "GET" || !list && !single) return
    // A reader's body is read after the map it shows arrived: answer once that map is known.
    latest = latest.then(() => response.json()).then((body: { missions?: MissionMap[]; mission?: MissionMap }) => {
      if (list && Array.isArray(body?.missions)) maps = new Map(body.missions.map(mission => [mission.id, mission]))
      if (single && body?.mission) maps.set(body.mission.id, body.mission)
    }).catch(() => undefined)
  })
  await page.route("**/missions/*/content**", async route => {
    await latest
    const request = route.request(), json = missionContentFixture(request.url(), request.method(), [...maps.values()], projectID)
    return json ? route.fulfill({ json }) : route.fallback()
  })
}
