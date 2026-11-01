import type { Route, Browser, BrowserContext, Page } from "playwright"
import { armFixtureNavigationBudget as armBudget } from "./fixture-navigation-budget"
import { compactMissionMap, missionTaskPage } from "../../../server/src/missions/mission-compact-map"
import { missionSummary } from "../../../server/src/missions/mission-summary"
import { missionPanelPage, missionPanelWindow, missionPanelTextWindow } from "../../../server/src/missions/mission-panel-page"
import { missionPanelHeader } from "../../../server/src/missions/mission-panel-header"
import { missionActivityContext, activityActorWindow } from "../../../server/src/missions/mission-activity-context"
import { contentDigest } from "../../../server/src/missions/content-digest"
import type { MissionMap, MissionPanelMap, MissionActivityProjection, MissionSummary, MissionCleanup } from "../../../server/src/api-types"
import { listedMissions } from "./mission-content-fixture"

export function waitForMissionPanelRefresh(page: Page) {
  const pending = page.waitForResponse(response => response.url().endsWith("/missions/panel-page") && response.request().postDataJSON()?.source === "summaries")
  return pending.then(async response => {
    await page.evaluate(async () => {
      const store = (await import("/src/stores/missions.ts")).missionStore
      ;(window as any).missionPanelRefreshSettled = () => store.demandedInstanceIds().every(id => store.state(id).status !== "loading" && !store.progress(id, "marks").loading
        && store.state(id).missions.every(map => !store.progress(id, `activity:${map.id}`).loading))
    })
    await page.waitForFunction(() => (window as any).missionPanelRefreshSettled())
    return response
  })
}

/** Preserve the established component datasets while migrating their read protocol. */
export function armFixtureNavigationBudget(browser: Browser, timeout = 120_000): void {
  armBudget(browser, timeout)
  const armed = new WeakSet<Page>()
  const arm = (page: Page) => {
    if (armed.has(page)) return page
    armed.add(page)
    const route = page.route.bind(page)
    page.route = async (pattern, handler, options) => {
      if (typeof pattern === "string" && pattern.endsWith("/missions/panel-page")) {
        return route(pattern, (own, request) => request.postDataJSON()?.source === "tasks" ? handler(own, request) : own.fallback(), options)
      }
      await route(pattern, handler, options)
      const example = new URL("http://fixture/api/workspaces/fixture/missions")
      const dataset = typeof pattern === "function" ? pattern(example) : typeof pattern === "string" ? pattern === "**/api/**" || /\/missions(?:\*\*)?$/.test(pattern) : pattern.test(example.toString())
      if (dataset) await route("**/api/workspaces/*/missions/panel-page", missionPanelRoute(handler as (route: Route) => unknown), options)
    }
    return page
  }
  const newPage = browser.newPage.bind(browser), newContext = browser.newContext.bind(browser)
  browser.newPage = async options => arm(await newPage(options))
  browser.newContext = async options => {
    const context = await newContext(options), page = context.newPage.bind(context)
    context.newPage = async () => arm(await page())
    return context
  }
}

/** Adapter for existing component fixtures' in-memory list datasets. The browser
 * still exercises only POST panelPage; all projections and byte fitting are the
 * actual producer functions. New inventory fixtures use the journal/HTTP producer
 * directly and assert real source/native counts independently of this adapter. */
export function missionPanelRoute(handler: (route: Route) => unknown) {
  let summaries: MissionSummary[] = []
  return async (route: Route) => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== "POST" || !url.pathname.endsWith("/missions/panel-page")) return handler(route)
    const input = request.postDataJSON()
    const reply = (options: Parameters<Route["fulfill"]>[0]) => route.fulfill(options).catch(error => {
      if (request.failure() || /Target page, context or browser has been closed/.test(String(error))) return
      throw error
    })
    // Existing task-specific fixtures own their task failure/continuation gates.
    if (input.source === "tasks" && /missionTaskFixture/.test(String(handler))) {
      let handled = false
      const proxy = new Proxy(route, { get(target, key) {
        if (key === "abort" || key === "fallback" || key === "continue") return (...args: unknown[]) => { handled = true; return (target as any)[key](...args) }
        if (key === "fulfill") return async (options: { json?: unknown; status?: number }) => {
          const value = options.json
          if (options.status && options.status >= 400 || value && typeof value === "object" && "available" in value) { handled = true; return reply(options) }
        }
        return typeof (target as any)[key] === "function" ? (target as any)[key].bind(target) : (target as any)[key]
      } })
      await handler(proxy)
      if (handled) return
    }
    let data: { available?: boolean; projectID?: string; missions?: MissionPanelMap[]; summaries?: MissionSummary[]; cleanups?: MissionCleanup[]; activity?: MissionActivityProjection; reason?: string; discardedEvents?: number; controlUnavailable?: boolean; notificationUnavailable?: boolean; cleanupUnavailable?: boolean } | undefined
    let status = 200, forwarded = false
    const lookup = new URL(request.url()); lookup.pathname = lookup.pathname.replace(/\/panel-page$/, "")
    lookup.searchParams.set("panelSource", input.source)
    if (input.header) lookup.searchParams.set("panelHeader", "true")
    if (input.missionID ?? input.task?.missionID) lookup.searchParams.set("include", input.missionID ?? input.task.missionID)
    const fakeRequest = new Proxy(request, { get(target, key) {
      if (key === "url") return () => lookup.toString()
      if (key === "method") return () => "GET"
      if (key === "postData") return () => null
      return typeof (target as any)[key] === "function" ? (target as any)[key].bind(target) : (target as any)[key]
    } })
    const dataset = new Proxy(route, { get(target, key) {
      if (key === "abort" || key === "fallback" || key === "continue") return (...args: unknown[]) => { forwarded = true; return (target as any)[key](...args) }
      if (key === "request") return () => fakeRequest
      if (key === "fulfill") return async (options: { json?: typeof data; body?: string; status?: number }) => { status = options.status ?? 200; data = options.json ?? (options.body ? JSON.parse(options.body) : undefined) }
      return typeof (target as any)[key] === "function" ? (target as any)[key].bind(target) : (target as any)[key]
    } })
    await handler(dataset)
    if (forwarded) return
    if (!data?.available) return reply({ status, json: data ?? { available: false, reason: "plugin-unavailable", missions: [] } })
    const maps = (data.missions ?? []).map(map => listedMissions().find(full => full.id === map.id && full.projectID === map.projectID && full.revision === map.revision) ?? map), projectID = data.projectID ?? maps[0]?.projectID ?? "project"
    summaries = data.summaries ?? (data.missions !== undefined ? maps.map(missionSummary) : summaries)
    const damage = { discardedEvents: data.discardedEvents ?? 0, controlUnavailable: data.controlUnavailable ?? false,
      notificationUnavailable: data.notificationUnavailable ?? false, cleanupUnavailable: data.cleanupUnavailable ?? false }
    const header = { source: input.source, projectID, ...damage }
    if (input.source === "summaries" || input.source === "cleanups") {
      const rows = input.source === "cleanups" ? data.cleanups ?? [] : summaries.map(({ actorSessionIds, ...row }) => ({ ...row, actorCount: actorSessionIds.length }))
      return reply({ json: missionPanelWindow({ ...header, ...(input.initial && !input.cursor ? { finishHighWater: Math.max(0, ...summaries.map(row => row.finishSequence ?? 0)) } : {}) }, rows, input.window, input.cursor) })
    }
    const observe = (map: MissionPanelMap, offset: number, limit: number) => {
      const context = activityActorWindow(missionActivityContext(map as MissionMap, damage), offset, limit)
      const prior = data!.activity?.missions.find(item => item.missionId === map.id), roots = new Set(context.actors.map(actor => actor.sessionId))
      const partial = roots.size < context.actorPage.total
      const coverage = prior?.family?.state === "unknown" ? "unknown" : partial ? "partial" : "observed"
      return { context, coverage, requests: { state: coverage, items: [] },
        activity: { actors: context.actors.map(actor => prior?.actors.find(item => item.sessionId === actor.sessionId) ?? { sessionId: actor.sessionId, state: "unknown" }),
          family: { state: partial ? "partial" : prior?.family?.state ?? "observed", members: prior?.family?.members.filter(member => roots.has(member.actorSessionId)) ?? [] } } }
    }
    if (input.source === "marks") {
      const order = contentDigest(JSON.stringify(maps.map(map => [map.id, map.revision]))), offset = Math.min(input.missionOffset ?? 0, maps.length), end = Math.min(offset + 16, maps.length)
      if (input.missionOrder && input.missionOrder !== order) return reply({ json: { available: false, reason: "changed" } })
      return reply({ json: missionPanelPage({ ...header, phase: "observed", observedAt: data.activity?.generatedAt ?? 1 }, [{ missionPage: { order, offset, end, total: maps.length }, observations: maps.slice(offset, end).map(map => observe(map, 0, 10)) }], input.cursor) })
    }
    const map = maps.find(map => map.id === (input.missionID ?? input.task?.missionID))
    if (!map) return reply({ json: { available: false, reason: "mission-not-found" } })
    const own = { ...header, missionID: map.id, revision: map.revision }
    if (input.source === "activity") return reply({ json: missionPanelPage({ ...own, phase: "observed", observedAt: data.activity?.generatedAt ?? 1 }, [observe(map, input.actorOffset ?? 0, 160)], input.cursor) })
    if (input.source === "tasks") return reply({ json: missionPanelPage(own, [missionTaskPage(map, input.task)], input.cursor) })
    if (input.header) return reply({ json: missionPanelPage({ ...own, header: true }, [missionPanelHeader(map as MissionMap)], input.cursor) })
    const value = input.part ? map.control?.[input.part as "receipts" | "pending"] : (compactMissionMap(map) as unknown as Record<string, unknown>)[input.field]
    if (value === undefined) return reply({ json: { available: false, reason: "field-not-found" } })
    if (input.text) return reply({ json: missionPanelTextWindow({ ...own, field: input.field, ...(input.part ? { part: input.part } : {}) }, value, input.window, input.cursor) })
    return reply({ json: missionPanelWindow({ ...own, field: input.field, ...(input.part ? { part: input.part } : {}) }, Array.isArray(value) ? value : [value], input.window, input.cursor) })
  }
}
