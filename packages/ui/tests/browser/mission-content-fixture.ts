import type { Page } from "playwright"
import type { MissionMap, MissionPanelMap } from "../../../server/src/api-types"
import { missionContentRequestSchema, readMissionContent } from "../../../server/src/missions/mission-content"
import { compactMissionMap, missionTaskPage, missionTaskRequestSchema } from "../../../server/src/missions/mission-compact-map"
import { isFullMissionMap } from "../../../server/src/missions/mission-panel-map"
import { missionPanelPage, missionPanelPageRequestSchema } from "../../../server/src/missions/mission-panel-page"

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

/** `full` as a plugin before task pages lists it: compact, every task and report row, no
 * page, row positions or history descriptor (its report rows hold no summary). The list
 * route pages such a map (`compactMissionMap`). */
export function olderPluginMap(full: MissionMap): MissionPanelMap {
  const { taskPage: _page, actorEvidence: _evidence, ...header } = compactMissionMap(full)
  const tasks = Array.from({ length: Math.ceil(full.tasks.length / 50) }, (_, index) => missionTaskPage(full, { offset: index * 50 }).tasks).flat()
    .map(({ order: _order, dependents: _dependents, reportCount: _count, lateReportCount: _late, bodies, ...row }) => {
      const { reports: _history, ...own } = bodies ?? {}
      return { ...row, bodies: own }
    })
  const ids = full.reports.map(report => report.id), reports = new Map<string, MissionPanelMap["reports"][number]>()
  for (let index = 0; index < ids.length; index += 50) for (const report of missionTaskPage(full, { reportIds: ids.slice(index, index + 50) }).reports) reports.set(report.id, report)
  return { ...header, tasks, reports: full.reports.map(report => reports.get(report.id)!) } as MissionPanelMap
}

/** Task display sources (panelPage POST and task GET) over the fixture's full maps,
 * using the real task projection and byte paginator; undefined for any other source. */
export function missionTaskFixture(url: string, method: string, values: readonly MissionMap[], projectID = "project", body?: string | null) {
  if (method === "POST" && new URL(url).pathname.endsWith("/missions/panel-page")) {
    const parsed = missionPanelPageRequestSchema.safeParse(JSON.parse(body ?? "null"))
    if (!parsed.success || parsed.data.source !== "tasks") return undefined
    const request = parsed.data, mission = values.find(value => value.id === request.task.missionID)
    if (!mission) return { available: false, reason: "mission-not-found" }
    const page = missionTaskPage(mission, request.task)
    if (request.task.order !== undefined && request.task.order !== page.taskPage.order) return { available: false, reason: "changed" }
    return missionPanelPage({ source: "tasks", projectID: mission.projectID, missionID: mission.id, revision: mission.revision,
      discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [page], request.cursor)
  }
  const parsed = new URL(url), match = /\/missions\/([^/]+)\/tasks$/.exec(parsed.pathname)
  if (!match || method !== "GET") return undefined
  const query = parsed.searchParams, list = (name: string) => query.has(name) ? query.get(name)!.split(",").filter(Boolean) : undefined
  const request = missionTaskRequestSchema.safeParse({ missionID: decodeURIComponent(match[1]), ...(query.has("order") ? { order: query.get("order") } : {}),
    ...(query.has("offset") ? { offset: Number(query.get("offset")) } : {}), ...(query.has("attention") ? { attention: Number(query.get("attention")) } : {}),
    ...(list("keys") ? { keys: list("keys") } : {}),
    ...(list("ids") ? { ids: list("ids") } : {}), ...(list("reports") ? { reportIds: list("reports") } : {}) })
  if (!request.success) return { error: "Invalid mission task request" }
  const mission = values.find(value => value.id === request.data.missionID)
  const base = { available: true, version: 1, projectID: mission?.projectID ?? projectID, missionID: request.data.missionID }
  if (!mission) return { ...base, refused: "mission-not-found" }
  const page = missionTaskPage(mission, request.data)
  return request.data.order !== undefined && request.data.order !== page.taskPage.order ? { ...base, revision: mission.revision, refused: "order-changed" }
    : { ...base, revision: mission.revision, ...page }
}

/** Existing semantic-selector assertions keep the same order/window/names, while
 * wire assertions inspect the actual POST body separately. */
export function missionTaskQuery(request: { url(): string; postData(): string | null }): string {
  const body = request.postData()
  if (!body) return new URL(request.url()).search
  const task = JSON.parse(body).task, query = new URLSearchParams()
  for (const key of ["order", "offset", "attention"]) if (task[key] !== undefined) query.set(key, String(task[key]))
  for (const key of ["keys", "ids", "reportIds"]) if (task[key]) query.set(key === "reportIds" ? "reports" : key, task[key].join(","))
  return `?${query}`
}

/** Serves the content route on `page` from `values()`, the fixture's full maps (registered
 * last, so it answers first). */
export async function routeMissionContent(page: Page, values: () => readonly MissionMap[], projectID = "project") {
  await page.route("**/missions/*/content**", route => {
    const request = route.request(), json = missionContentFixture(request.url(), request.method(), values(), projectID)
    return json ? route.fulfill({ json }) : route.fallback()
  })
}

/** Serves the task panelPage source from `values()`, the fixture's full maps (registered
 * last, so it answers first); `requests` records each logical selector as a query. */
export async function routeMissionTasks(page: Page, values: () => readonly MissionMap[], requests: string[] = [], projectID = "project") {
  await page.route("**/missions/panel-page", route => {
    const request = route.request(), json = missionTaskFixture(request.url(), request.method(), values(), projectID, request.postData())
    if (json) requests.push(missionTaskQuery(request))
    return json ? route.fulfill({ json }) : route.fallback()
  })
}
