import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import { chromium, type Browser, type Locator, type Page, type Request } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionActivityProjection } from "../../../server/src/api-types"
import type { V2Event, SessionMessageUser } from "@opencode/client"
import { outlineInputSchema, outlineResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema,
  navigationWindowInputSchema, navigationWindowResultSchema } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { answerMissionRow, expandRow, inlineMissionEntry, missionRow, selectedMissionTitle } from "./mission-actions"
import type {} from "./fixtures/mission-native-family"
import { panelMissions } from "./mission-content-fixture"
import { collectPanelReadFailures, PANEL_READ_HEADER } from "./panel-read-fixture"
import { collectMissionReadFailures, MISSION_READ_HEADER } from "./mission-read-observation-fixture"

let server: ViteDevServer, browser: Browser, url: string, output: string
before(async () => {
  const root = process.env.CODENOMAD_NATIVE_FAMILY_EVIDENCE || path.join(tmpdir(), "opencode")
  assert(path.isAbsolute(root)); await mkdir(root, { recursive: true })
  output = await mkdtemp(path.join(root, "mission-native-family-"))
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [solid(), shutdown.plugin, { name: "mission-native-family", configureServer(s) {
        s.middlewares.use("/api/events", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write(": isolated fake transport; native frames use the real dispatcher\n\n") })
        s.middlewares.use("/mission-native-family", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-native-family", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-native-family.tsx"></script></body></html>'))
      }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server); await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-native-family`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() }; console.info(`Family fixture logs: ${output}`) })
function mission(id: string, independent = false, task = false): MissionMap {
  const actor = (name: string, kind: "coordinator" | "specialist") => ({ sessionId: `ses_${name}`, kind, managed: false,
    title: `Declared ${name}`, roles: [kind], location: { directory: "/fixture" }, joinedAt: 1 })
  // Optionally, Mission A's live task held by its declared specialist (whose descendants ask).
  const tasks: MissionMap["tasks"] = task && id === "A" ? [{ id: "task-work", key: "work", title: "Delegated work", brief: "Work", role: "specialist",
    status: "dispatching", blockedBy: [], actorSessionId: "ses_actor", outstandingExecution: false, createdAt: 1, updatedAt: 1 }] : []
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: id === "A" ? [actor("A", "coordinator"), actor("actor", "specialist"), ...(independent ? [actor("independent", "specialist")] : [])] : [actor("B", "coordinator")],
    tasks, reports: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
const observedFamily: NonNullable<MissionActivityProjection["missions"][number]["family"]> = { state: "observed", members: [
  { sessionId: "ses_A", actorSessionId: "ses_A", kind: "declared" },
  { sessionId: "ses_actor", parentSessionId: "ses_A", actorSessionId: "ses_actor", kind: "declared" },
  { sessionId: "ses_child", parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_grandchild", parentSessionId: "ses_child", actorSessionId: "ses_actor", kind: "ordinary" },
] }
const deepFamily: typeof observedFamily = { state: "observed", members: ([...observedFamily.members,
  { sessionId: "ses_third", parentSessionId: "ses_grandchild", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_fourth", parentSessionId: "ses_third", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_fifth", parentSessionId: "ses_fourth", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_independent", actorSessionId: "ses_independent", kind: "declared" },
] satisfies typeof observedFamily.members).reverse() }
function nativeHistory(sessionId: string): SessionMessageUser[] {
  assert.match(sessionId, /^ses_[A-Za-z_]+$/)
  return [1, 2].map(n => ({ id: `msg_${sessionId}_${n}`, type: "user", time: { created: n }, text: `Bounded native history ${sessionId} ${n}` }))
}
async function setup(label: string, narrow = false, independent = false, task = false) {
  const page = await browser.newPage({ locale: narrow ? "he-IL" : "en-US", viewport: narrow ? { width: 390, height: 600 } : { width: 1600, height: 950 },
    hasTouch: narrow, deviceScaleFactor: 1 })
  page.setDefaultTimeout(12000)
  const errors: string[] = [], failures: string[] = [], consoleErrors: string[] = [], requests: Array<{ method: string; path: string; body?: unknown; source?: string | null }> = []
  const voidResponses = new Set<Request>(), voidBodyCancellations: string[] = []
  const panelReads = collectPanelReadFailures(page, url)
  const missionReads = collectMissionReadFailures(page, url)
  const { rawRequestFailures, panelListCancellations } = panelReads
  const navigationReadCancellations: Array<{ failure: string; requestedSession: string; activeSession: string }> = []
  const failureChecks: Promise<unknown>[] = [], outlineResponses: Array<{ session: string; at: number }> = []
  const drainRequestFailures = async () => { await panelReads.drain(); await missionReads.drain(); await Promise.all(failureChecks) }
  const receipts: Array<{ method: string; path: string; status: number }> = [], fallbackResponses: string[] = []
  let family = structuredClone(independent ? deepFamily : observedFamily), deferred = false, release!: () => void, reached!: () => void, completed!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), arrival = new Promise<void>(resolve => { reached = resolve })
  const completion = new Promise<void>(resolve => { completed = resolve })
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("response", response => {
    if (response.status() === 204) voidResponses.add(response.request())
    if (response.url().includes("/api/")) receipts.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() })
  })
  page.on("requestfailed", request => {
    const message = `${request.url()} ${request.failure()?.errorText}`
    if (request.headers()[MISSION_READ_HEADER]) { missionReads.record(request, failures); return }
    if (panelReads.record(request, failures)) return
    // The actual Promise client cancels empty-response bodies. Retain these
    // confirmed 204 receipts separately, never excuse an unconfirmed failure.
    if (voidResponses.has(request) && request.failure()?.errorText === "net::ERR_ABORTED") voidBodyCancellations.push(message)
    else if (request.method() === "POST" && ["outline", "outlinePreview"].some(route => new URL(request.url()).pathname === `/api/workspaces/native-family/session-history/${route}`)
      && request.failure()?.errorText === "net::ERR_ABORTED") {
      // Production timeline-previews.ts and session-outline.ts abort demand on
      // session/inactive cleanup. Verify the exact old-session request before
      // classifying it; retain the raw failure and never count an abort as a
      // response receipt.
      const preview = new URL(request.url()).pathname.endsWith("/outlinePreview")
      const requestedSession = (preview ? outlinePreviewInputSchema : outlineInputSchema).parse(request.postDataJSON()).sessionID
      // session-outline.ts also re-keys demand when the session's native
      // identity settles; accept that abort only once a later request for the
      // same session actually received an outline response.
      const supersededAt = Date.now()
      failureChecks.push(page.evaluate(() => window.missionNativeFamily?.snapshot().session).then(async activeSession => {
        if (activeSession && activeSession !== requestedSession) return navigationReadCancellations.push({ failure: message, requestedSession, activeSession })
        // timeline-previews.ts also aborts optional excerpts whenever the
        // requested marker set changes (hover, visible window) in the same session.
        if (preview) return navigationReadCancellations.push({ failure: message, requestedSession, activeSession: activeSession ?? "" })
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && !outlineResponses.some(item => item.session === requestedSession && item.at >= supersededAt)) await new Promise(resolve => setTimeout(resolve, 50))
        if (outlineResponses.some(item => item.session === requestedSession && item.at >= supersededAt))
          return navigationReadCancellations.push({ failure: message, requestedSession, activeSession: activeSession ?? "" })
        failures.push(message)
      }).catch(() => { failures.push(message) }))
    } else failures.push(message)
  })
  page.on("requestfinished", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/workspaces/native-family/session-history/outline")
      outlineResponses.push({ session: outlineInputSchema.parse(request.postDataJSON()).sessionID, at: Date.now() })
  })
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, location = { directory: "/fixture" }
    requests.push({ method: request.method(), path: pathname, source: new URL(request.url()).searchParams.get("panelSource"), ...(request.postData() ? { body: request.postDataJSON() } : {}) })
    if (pathname === "/api/events") return route.continue()
    if (pathname === "/api/panel-extensions") return route.fulfill({ json: [] })
    if (pathname.endsWith("/missions/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project", schedules: [] } })
    if (pathname.endsWith("/schedule")) return route.fulfill({ json: { version: 1, projectID: "project" } })
    if (pathname === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: narrow ? "he" : "en", showMessageTimeline: true } } })
    if (pathname === "/api/workspaces/native-family/integrations") return route.fulfill({ json: { location, catalog: { state: "fresh" }, integrations: [] } })
    // CodeNomad's canonical bounded pruning routes, not guessed native URLs.
    if (pathname === "/api/workspaces/native-family/session-history/outline") {
      const input = outlineInputSchema.parse(request.postDataJSON()), messages = nativeHistory(input.sessionID)
      return route.fulfill({ json: outlineResultSchema.parse({ status: "outline", total: messages.length, cursor: null,
        entries: messages.map((message, seq) => ({ id: message.id, seq, type: message.type, tools: 0, reasoning: 0 })),
        checkpoints: [{ after: -1, through: messages.length - 1, digest: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), changed: true }] }) })
    }
    if (pathname === "/api/workspaces/native-family/session-history/outlinePreview") {
      const input = outlinePreviewInputSchema.parse(request.postDataJSON())
      return route.fulfill({ json: outlinePreviewResultSchema.parse({ status: "previews", entries: nativeHistory(input.sessionID)
        .filter(message => input.messageIDs.includes(message.id)).map(message => ({ id: message.id, text: message.text, tools: "" })) }) })
    }
    if (pathname === "/api/workspaces/native-family/session-history/window") {
      const input = navigationWindowInputSchema.parse(request.postDataJSON())
      return route.fulfill({ json: navigationWindowResultSchema.parse({ status: "window", messages: nativeHistory(input.sessionID),
        older: null, newer: null, resume: { kind: "latest" }, latest: true }) })
    }
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([mission("A", independent, task), mission("B")]), generatedAt: 1, discardedEvents: 0,
      activity: { generatedAt: 1, missions: [{ missionId: "A", actors: independent ? [
        { sessionId: "ses_A", state: "running" }, { sessionId: "ses_actor", state: "running" },
      ] : [], family }, { missionId: "B", actors: [], family: { state: "unknown", members: [] } }] } } })
    if (pathname.endsWith("/worktrees")) return route.fulfill({ json: { isGitRepo: true, worktrees: [{ slug: "root", directory: "/fixture", kind: "root" }] } })
    if (pathname.endsWith("/prompt")) return route.fulfill({ json: { id: (request.postDataJSON() as { id: string }).id } })
    if (request.method() !== "GET" && pathname.startsWith("/workspaces/")) return route.fulfill({ status: 204 })
    if (pathname.endsWith("/command")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: { location, data: [{ id: "build", name: "build", mode: "primary" }] } })
    const model = { id: "fixture", providerID: "fixture", name: "Fixture", status: "active", variants: [],
      limit: { context: 100000, output: 4096 }, cost: [{ input: 0, output: 0 }] }
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { location, data: [{ id: "fixture", name: "Fixture" }] } })
    if (pathname.endsWith("/model")) return route.fulfill({ json: { location, data: [model] } })
    if (pathname.endsWith("/model/default")) return route.fulfill({ json: { location, data: model } })
    if (pathname.endsWith("/active")) return route.fulfill({ json: { ses_grandchild: { type: "running" } } })
    // Generated Promise client.message.list uses /api/session/:id/message.
    const messageSession = pathname.match(/^\/workspaces\/native-family\/instance\/api\/session\/(ses_[A-Za-z_]+)\/message$/)?.[1]
    if (messageSession) return route.fulfill({ json: new URL(request.url()).searchParams.has("cursor")
      ? { data: nativeHistory(messageSession).slice(0, 1), cursor: {} }
      : { data: nativeHistory(messageSession).slice(-1), cursor: { next: "fixture_older" } } })
    if (pathname.includes("/inbox")) return route.fulfill({ json: [] })
    if (pathname.includes("/form")) return route.fulfill({ json: { data: [] } })
    if (pathname.endsWith("/permission-receipts")) return route.fulfill({ json: { receipts: [] } })
    const nativeID = pathname.match(/\/session\/(ses_[A-Za-z_]+)$/)?.[1]
    if (nativeID) {
      const waitForChild = deferred && nativeID === "ses_child"
      if (waitForChild) { reached(); await hold }
      const parents: Record<string, string> = { ses_actor: "ses_A", ses_child: "ses_actor", ses_grandchild: "ses_child",
        ses_third: "ses_grandchild", ses_fourth: "ses_third", ses_fifth: "ses_fourth", ses_born: "ses_actor", ses_fork: "ses_actor" }
      await route.fulfill({ json: { id: nativeID, ...(parents[nativeID] ? { parentID: parents[nativeID] } : {}), projectID: "project", agent: "build", location,
        title: `Conversation ${nativeID.slice(4)}`, model: { providerID: "fixture", id: "fixture" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } } })
      if (waitForChild) completed()
      return
    }
    if (pathname.includes("/session")) return route.fulfill({ json: { data: [], cursor: {} } })
    fallbackResponses.push(`${request.method()} ${pathname}`)
    return route.fulfill({ json: {} })
  })
  const save = async () => {
    await drainRequestFailures()
    await writeFile(path.join(output, `${label}.json`), JSON.stringify({ transport: "isolated-http-fakes", errors, failures, consoleErrors, rawRequestFailures, missionReadFailures: missionReads.raw, missionReadCancellations: missionReads.cancelled, navigationReadCancellations, panelListCancellations, voidBodyCancellations, requests, receipts, fallbackResponses,
      apiCounts: Object.fromEntries([...new Set(requests.map(item => `${item.method} ${item.path}`))].map(key => [key, requests.filter(item => `${item.method} ${item.path}` === key).length])),
      snapshot: await page.evaluate(() => window.missionNativeFamily?.snapshot()).catch(() => null),
      openGates: ["live authenticated HTTP/SSE desktop host", "invocation profile provenance"] }, null, 2))
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true }).catch(() => {})
  }
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); await page.waitForFunction(() => window.missionNativeFamily?.snapshot().session === "ses_B", undefined, { timeout: 30000 })
    await page.evaluate(async () => {
      const { serverApi } = await import("/src/lib/api-client.ts")
      const { observeMissionReads } = await import("/tests/browser/mission-read-observation-fixture.ts")
      observeMissionReads(serverApi)
    })
    // Only the picker selects a Mission: restoring a coordinator conversation leaves none selected.
    if (!narrow) await page.locator(".mission-rows button.mission-row-select").first().waitFor()
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).selectedMission, undefined) }
  catch (error) { await save(); release(); await page.close(); throw error }
  return { page, errors, failures, requests, rawRequestFailures, panelListCancellations, save, drainRequestFailures, arrival, completion, release, defer: () => { deferred = true },
    setFamily: (next: typeof observedFamily) => { family = next },
    unknown: () => { family = { state: "unknown", members: observedFamily.members } } }
}
const composer = (page: Page) => page.locator("textarea.prompt-input:visible")
const selectedMission = async (page: Page) => (await page.evaluate(() => window.missionNativeFamily.snapshot())).selectedMission
/** The user's explicit row choice, the only route that changes the selected Mission (locale-neutral). */
async function pickMission(page: Page, id: "A" | "B") {
  const session = (await page.evaluate(() => window.missionNativeFamily.snapshot())).session
  const entry = await inlineMissionEntry(page, `Objective ${id}`)
  if (await selectedMission(page) !== id) await entry.click()
  await page.waitForFunction(id => window.missionNativeFamily.snapshot().selectedMission === id, id)
  // A click only selects the row; its chevron shows its tasks.
  await expandRow(entry)
  assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, session, "picking a Mission does not navigate")
}
async function select(page: Page, id: string) {
  const row = page.locator(`.session-sidebar [data-session-id="ses_${id}"]`)
  await row.locator(".session-item-select").click()
  await page.waitForFunction(id => window.missionNativeFamily.snapshot().session === `ses_${id}`, id)
}
async function expand(page: Page, id: string) {
  const button = page.locator(`.session-sidebar [data-session-id="ses_${id}"] .session-item-expander`)
  if (await button.getAttribute("aria-expanded") !== "true") await button.click()
}
async function refreshMap(page: Page) {
  const response = waitForMissionPanelRefresh(page)
  await page.getByRole("button", { name: "Refresh mission map", exact: true }).click()
  await response
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
/** Raise a native Form on the ordinary child conversation and answer it from the
 * Mission's red row: no loaded task carries the child's question, so the flag does,
 * and selecting the row opens that conversation with the question focused. */
async function answerChild(page: Page) {
  await page.evaluate(() => window.missionNativeFamily.emit({ type: "form.created", id: "event-child-form", created: 1, location: { directory: "/fixture" },
    data: { form: { id: "child-form", sessionID: "ses_child", title: "Child form", fields: [{ type: "string", key: "answer", title: "Child answer" }] } } }))
  await answerMissionRow(page, "Objective A")
}

test("production SessionList/SessionView select recursive children, steer/queue only that child and preserve coordinator/sibling drafts", { timeout: 60000 }, async () => {
  const ctx = await setup("child-steer-queue"), { page, requests } = ctx
  try {
    await composer(page).fill("Sibling B draft")
    await select(page, "A"); await composer(page).fill("Coordinator A draft")
    await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await pickMission(page, "A")
    await select(page, "B")
    assert.equal(await selectedMission(page), "A", "an unrelated coordinator conversation keeps the picked Mission")
    await select(page, "grandchild")
    assert.equal(await selectedMission(page), "A")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).root, "ses_A")
    assert.equal(await composer(page).inputValue(), "")
    const steer = page.waitForResponse(response => response.url().endsWith("/session/ses_grandchild/prompt") && response.request().method() === "POST")
    await composer(page).fill("Child steer only"); await composer(page).press("Enter"); assert.equal((await steer).status(), 200)
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.prompt-input")?.value === "")
    const queue = page.waitForResponse(response => response.url().endsWith("/session/ses_grandchild/prompt") && response.request().method() === "POST")
    await composer(page).fill("Child queue only"); await composer(page).press("Control+Shift+Enter"); assert.equal((await queue).status(), 200)
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.prompt-input")?.value === "")
    const prompts = requests.filter(item => item.path.endsWith("/prompt"))
    assert.equal(prompts.length, 2)
    assert(prompts.every(item => item.path.includes("/session/ses_grandchild/")))
    assert.deepEqual(prompts.map(item => [(item.body as { text: string }).text, (item.body as { delivery: string }).delivery]), [["Child steer only", "steer"], ["Child queue only", "queue"]])
    assert.equal((prompts[1].body as { resume: boolean }).resume, false)
    assert(requests.filter(item => item.method !== "GET" && item.path.includes("/session/")).every(item => item.path.includes("/session/ses_grandchild/")))
    await select(page, "child")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_child")
    await select(page, "A"); assert.equal(await composer(page).inputValue(), "Coordinator A draft")
    await select(page, "B"); assert.equal(await composer(page).inputValue(), "Sibling B draft")
    assert.equal(await selectedMission(page), "A")
    assert.equal(requests.filter(item => item.path === "/api/workspaces/native-family/integrations").length, 0,
      "Mission navigation keeps Status hidden and never demands integration status")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("only the explicit picker choice selects a Mission; coordinator, worker and descendant navigation keep it", { timeout: 60000 }, async () => {
  const ctx = await setup("manual-mission-selection"), { page } = ctx
  const title = () => selectedMissionTitle(page).innerText()
  try {
    await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    // Arriving in Mission A's coordinator selects nothing by itself.
    await select(page, "A"); assert.equal(await selectedMission(page), undefined)
    await pickMission(page, "B"); assert.equal(await title(), "Objective B")
    for (const id of ["A", "actor", "child", "grandchild", "outside", "B", "A"]) {
      await select(page, id)
      assert.equal(await selectedMission(page), "B", `ses_${id} keeps the picked Mission`)
    }
    assert.equal(await title(), "Objective B")
    await pickMission(page, "A")
    for (const id of ["B", "outside", "grandchild"]) {
      await select(page, id)
      assert.equal(await selectedMission(page), "A", `ses_${id} keeps the picked Mission`)
    }
    assert.equal(await title(), "Objective A")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

// Observation, not a substitute composer implementation: read production DOM
// after fonts and viewport measurements remain stable for eight animation frames.
async function captureComposer(page: Page, name: string, sessionId: string) {
  const measurement = await page.evaluate(() => window.missionNativeFamily.measureComposer())
  assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, sessionId)
  assert(measurement.stableFrames >= 8, "bounded measurement settled")
  assert.equal(measurement.viewport.scale, 1); assert.equal(measurement.viewport.devicePixelRatio, 1)
  assert(measurement.textboxAndFooterSeparate); assert(measurement.footerInsideViewport)
  assert(measurement.textboxHitTesting); assert(measurement.sendHitTesting)
  assert(!measurement.htmlOverflow)
  await writeFile(path.join(output, `${name}.geometry.json`), JSON.stringify({ sessionId, ...measurement,
    qualification: measurement.firstLineOverlapsHelp ? "composer overlap reproduced; not a visual pass" : "this capture has separate text/help geometry" }, null, 2))
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false })
  assert.equal(measurement.firstLineOverlapsHelp, false, "native placeholder/text first line cannot intersect the actual visible helper")
  if (measurement.overlay) {
    assert(measurement.overlay.height > 0 && measurement.overlayText?.trim(), "visible helper is nonempty")
    assert(measurement.overlay.y >= measurement.textContentBottom, "helper is outside the native text content area")
    assert(measurement.overlay.bottom <= measurement.textarea.bottom && measurement.overlay.bottom <= measurement.footer.y)
    assert(measurement.helperHitTesting, "actual helper receives pointer hits in its reserved strip")
    assert(measurement.helperDescription, "textarea retains a semantic reference to all helper content")
  }
  return measurement
}

test("desktop child/grandchild composer has no permanent key strip at zoom 1", { timeout: 60000 }, async () => {
  const ctx = await setup("visual-desktop"), { page } = ctx
  try {
    await select(page, "A"); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    for (const id of ["child", "grandchild"]) {
      await select(page, id)
      await page.getByText(`Bounded native history ses_${id} 2`, { exact: true }).waitFor()
      await page.locator(`.message-timeline-segment[data-message-id="msg_ses_${id}_1"]:visible`).waitFor()
      assert.equal(await page.getByText("Full timeline unavailable", { exact: true }).count(), 0)
      const empty = await captureComposer(page, `desktop-${id}-empty`, `ses_${id}`)
      assert.equal(empty.overlay, null, "empty desktop composers do not mount permanent keyboard help")
      await composer(page).fill(`Visible draft ses_${id}`)
      const draft = await captureComposer(page, `desktop-${id}-draft`, `ses_${id}`)
      assert.equal(draft.value, `Visible draft ses_${id}`); assert.equal(draft.overlay, null)
      assert.equal(draft.textarea.height, empty.textarea.height, "draft does not change minimum height")
      await composer(page).fill("")
    }
    const marker = page.locator('.message-timeline-segment[data-message-id="msg_ses_grandchild_1"]:visible')
    await marker.hover()
    await page.locator(".message-timeline-tooltip").getByText("Bounded native history ses_grandchild 1", { exact: true }).waitFor()
    const windowReceipt = page.waitForResponse(response => response.url().endsWith("/session-history/window"))
    await marker.click(); assert.equal((await windowReceipt).status(), 200)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("390x600 RTL touch visual investigation retains exact child/grandchild drafts and production footer at the same zoom", { timeout: 60000 }, async () => {
  const ctx = await setup("visual-rtl-touch", true), { page } = ctx
  try {
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    const openSessions = async () => {
      if (await page.locator('.session-sidebar [data-session-id="ses_B"]:visible').count()) return
      const toggle = page.locator(".shell-panel-toggle--left button:visible")
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.tap()
    }
    await openSessions(); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    for (const id of ["child", "grandchild"]) {
      // Choosing from the floating session panel closes it.
      await openSessions(); await select(page, id)
      await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
      await page.getByText(`Bounded native history ses_${id} 2`, { exact: true }).waitFor()
      const empty = await captureComposer(page, `rtl-touch-${id}-empty`, `ses_${id}`)
       assert.equal(empty.overlay, null, "empty touch composers do not mount permanent keyboard help")
      assert.equal(empty.viewport.coarse, true)
      await composer(page).fill(`Visible draft ses_${id}`)
      const draft = await captureComposer(page, `rtl-touch-${id}-draft`, `ses_${id}`)
      assert.equal(draft.value, `Visible draft ses_${id}`)
      assert.equal(draft.textarea.height, empty.textarea.height)
      await composer(page).fill("")
    }
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("44px desktop floor reserves overlay padding only for composer status", { timeout: 60000 }, async () => {
  const ctx = await setup("helper-44px-floor"), { page } = ctx
  try {
    await select(page, "A"); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await select(page, "grandchild")
    await page.setViewportSize({ width: 1600, height: 390 })
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>("textarea.prompt-input")]
      .some(node => node.getBoundingClientRect().height === 44))
    const empty = await captureComposer(page, "desktop-grandchild-44px-empty", "ses_grandchild")
    assert.equal(empty.textarea.height, 44); assert.equal(empty.overlay, null)
    assert.equal(await composer(page).getAttribute("aria-describedby"), null)
    assert.equal(await composer(page).evaluate(node => getComputedStyle(node).paddingBottom), "12px")
    await composer(page).press("!")
    const status = page.locator(".prompt-input-overlay:visible")
    await status.waitFor()
    assert.match(await status.innerText(), /Shell mode active/)
    assert.equal(await status.locator("kbd").count(), 0)
    assert.equal(await composer(page).getAttribute("aria-describedby"), await status.getAttribute("id"))
    assert.equal(await composer(page).evaluate(node => node.getBoundingClientRect().height), 44)
    await composer(page).press("Escape")
    await status.waitFor({ state: "hidden" })
    const resize = page.locator(".prompt-resize-handle:visible")
    assert.equal(Number(await resize.getAttribute("aria-valuemin")), 44)
    assert.equal(Number(await resize.getAttribute("aria-valuemax")), 234)
    await composer(page).fill(Array.from({ length: 30 }, (_, n) => `Draft line ${n}`).join("\n"))
    assert.equal(await composer(page).evaluate(node => node.getBoundingClientRect().height), 44)
    assert(await composer(page).evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === "auto"))
    await composer(page).fill("")
    await captureComposer(page, "desktop-grandchild-44px-restored", "ses_grandchild")
    // A legacy visibility preference cannot restore removed key strips.
    await page.evaluate(() => { document.documentElement.dataset.keyboardHints = "hide" })
    assert.equal(await page.locator(".prompt-input-overlay").count(), 0)
    assert.equal(await composer(page).evaluate(node => getComputedStyle(node).paddingBottom), "12px")
    assert.equal(await composer(page).evaluate(node => node.getBoundingClientRect().height), 44)
    await page.evaluate(() => { delete document.documentElement.dataset.keyboardHints })
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("native Chromium touch resize preserves the chosen proportion, exact draft and coarse-pointer footer through viewport changes", { timeout: 60000 }, async () => {
  const ctx = await setup("touch-saved-proportion", true), { page } = ctx
  const touch = await page.context().newCDPSession(page)
  try {
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    await page.locator(".shell-panel-toggle--left button:visible").tap()
    await expand(page, "A"); await expand(page, "actor"); await select(page, "child")
    // Choosing from the floating session panel closes it.
    await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
    await composer(page).fill("Touch resize draft ses_child")
    await captureComposer(page, "rtl-touch-child-before-resize", "ses_child")
    const resize = page.locator(".prompt-resize-handle:visible"), rect = await resize.boundingBox()
    assert(rect)
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 100 }] })
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const saved = (await page.evaluate(() => window.missionNativeFamily.snapshot())).heightPreference
    assert(saved && typeof saved === "object" && saved.ratio > 0.2 && saved.ratio < 0.4)
    for (const height of [800, 390, 600]) {
      await page.setViewportSize({ width: 390, height })
      await page.waitForFunction(ratio => [...document.querySelectorAll<HTMLTextAreaElement>("textarea.prompt-input")]
        .some(node => node.getBoundingClientRect().height === Math.max(44, Math.round(innerHeight * ratio))), saved.ratio)
      assert.deepEqual((await page.evaluate(() => window.missionNativeFamily.snapshot())).heightPreference, saved)
      assert.equal(await composer(page).inputValue(), "Touch resize draft ses_child")
    }
    const manual = await captureComposer(page, "rtl-touch-child-saved-proportion", "ses_child")
    assert.equal(manual.textarea.height, Math.round(600 * saved.ratio)); assert.equal(manual.overlay, null)
    assert.equal(Number(await resize.getAttribute("aria-valuemin")), 48)
    assert.equal(Number(await resize.getAttribute("aria-valuemax")), 360)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); await touch.detach(); ctx.release(); await page.close() }
})

test("descendant attention opens its exact dock; global stays uncorrelated and unknown family hides only ordinary rows", { timeout: 60000 }, async () => {
  const ctx = await setup("attention-unknown"), { page, requests } = ctx
  try {
    await select(page, "A"); await pickMission(page, "A"); await page.evaluate(() => window.missionNativeFamily.ask())
    // No loaded task carries the descendant's question: the Mission's red row opens it.
    await answerMissionRow(page, "Objective A")
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().session === "ses_grandchild")
    assert.equal(await page.locator(".interruption-dock").getByRole("form", { name: "Global choice", exact: true }).count(), 0)
    const form = page.locator(".interruption-dock").getByRole("form", { name: "Child choice", exact: true })
    await form.locator('input[type="text"]').fill("Answer through native dock")
    const receipt = page.waitForResponse(response => response.url().endsWith("/form/child-question/reply") && response.request().method() === "POST")
    await form.locator('button[type="submit"]').click(); assert.equal((await receipt).status(), 204)
    await form.waitFor({ state: "detached" })
    const replies = requests.filter(item => item.path.includes("/form/") && item.method !== "GET")
    assert.equal(replies.length, 1); assert(replies[0].path.includes("/session/ses_grandchild/"))
    await page.evaluate(() => window.missionNativeFamily.askPermission())
    // Upstream's dock retains its selected request instead of automatically
    // selecting a newly enqueued permission; the red row focuses the exact one.
    await answerMissionRow(page, "Objective A")
    await page.locator(".interruption-dock").getByRole("button", { name: "Allow Once", exact: true }).waitFor()
    assert((await page.locator(".interruption-dock").innerText()).includes("safe-fixture.txt"))
    const permissionReceipt = page.waitForResponse(response => response.url().includes("child-permission") && response.request().method() !== "GET")
    await page.locator(".interruption-dock").getByRole("button", { name: "Allow Once", exact: true }).click()
    assert.equal((await permissionReceipt).status(), 204)
    await missionRow(page, "Objective A").locator('.mission-row-flag[data-mark="permission"]').waitFor({ state: "detached" })
    const permissionReplies = requests.filter(item => item.path.includes("child-permission") && item.method !== "GET")
    assert.equal(permissionReplies.length, 1); assert(permissionReplies[0].path.includes("/session/ses_grandchild/"))
    ctx.unknown(); await refreshMap(page)
    await pickMission(page, "B"); await select(page, "grandchild")
    assert.equal(await selectedMission(page), "B", "neither local ancestry nor an unknown family observation replaces the picked Mission")
    await select(page, "A")
    assert.equal(await selectedMission(page), "B")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("a red task opens its asking descendant with the question focused; the Mission's flag stays its own", { timeout: 60000 }, async () => {
  const ctx = await setup("red-task", false, false, true), { page } = ctx
  try {
    await select(page, "A"); await pickMission(page, "A"); await page.evaluate(() => window.missionNativeFamily.ask())
    const task = page.locator('.mission-tree li[data-task-key="work"][data-state="input"]')
    await task.waitFor()
    const row = missionRow(page, "Objective A")
    assert.equal(await row.locator(".session-item-expander").getAttribute("data-child-activity"), "permission", "the chevron carries the task's question")
    assert.equal(await row.locator('.mission-row-flag[data-mark="permission"]').count(), 0, "the task's question is not the Mission's")
    await task.locator(".mission-tree-task").click()
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().session === "ses_grandchild")
    await page.locator(".interruption-dock").getByRole("form", { name: "Child choice", exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").count(), 0, "a red task opens its question, not its reader")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("390px RTL red Mission row selects the exact same-active-child permission before closing its owned drawer", { timeout: 60000 }, async () => {
  const ctx = await setup("attention-same-child-rtl", true), { page, requests } = ctx
  try {
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    // Each choice from the floating session panel closes it; reopen it to expand the family.
    await page.locator(".shell-panel-toggle--left button:visible").tap()
    await select(page, "A")
    await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
    await page.locator(".shell-panel-toggle--left button:visible").tap()
    await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await select(page, "grandchild")
    await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
    await page.evaluate(() => window.missionNativeFamily.askPermission())
    await page.locator('.interruption-dock .interruption-navigation button').filter({ has: page.locator('svg.lucide-chevron-right') }).tap()
    await page.waitForFunction(() => document.querySelector(".interruption-dock")?.textContent?.includes("global-fixture.txt"))
    await page.locator(".shell-panel-toggle--right button:visible").tap()
    const selectedSchedule = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/missions/A/schedule"))
    await pickMission(page, "A")
    await (await selectedSchedule).json()
    // The red row opens the exact correlated permission; the global one is never a Mission's.
    const row = missionRow(page, "Objective A")
    await row.locator('.mission-row-flag[data-mark="permission"]').waitFor()
    await row.locator(".mission-row-select").tap()
    await page.waitForFunction(() => document.querySelector(".interruption-dock")?.textContent?.includes("safe-fixture.txt"))
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_grandchild")
    await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
    assert.equal((await page.locator(".interruption-dock").innerText()).includes("global-fixture.txt"), false)
    assert.equal(requests.filter(item => item.path.includes("permission") && item.method !== "GET").length, 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("native catalog supersession is recorded separately while real catalog and unrelated aborts remain failures", { timeout: 60000 }, async () => {
  const ctx = await setup("catalog-cancellation"), { page } = ctx
  let release!: () => void, arrived!: (request: Request) => void, first = true
  const held = new Promise<void>(resolve => { release = resolve })
  const arrival = new Promise<Request>(resolve => { arrived = resolve })
  const catalog = new URL("/api/panel-extensions", url).href
  try {
    await page.route(catalog, async route => {
      if (first) { first = false; arrived(route.request()); await held }
      await route.fulfill({ json: [] })
    })
    await page.evaluate(() => window.missionNativeFamily.transport("connected"))
    const pending = await arrival, readId = pending.headers()[PANEL_READ_HEADER]
    assert.ok(readId, "the actual production list call has a unique fixture identity")
    const cancelled = page.waitForEvent("requestfailed", request => request === pending)
    const replacement = page.waitForResponse(response => response.url() === catalog && response.request() !== pending)
    await page.evaluate(() => window.missionNativeFamily.transport("connected"))
    await cancelled
    assert.deepEqual(await (await replacement).json(), [], "the replacement read succeeds")
    release(); await ctx.drainRequestFailures()
    assert.deepEqual(ctx.failures, [])
    assert.ok(ctx.panelListCancellations.some(read => read.readId === readId))
    assert.ok(ctx.rawRequestFailures.includes(`${catalog} net::ERR_ABORTED`))

    // Same URL and error code, but without an owning-signal AbortError receipt.
    await page.route(catalog, route => route.abort("aborted"))
    const broken = page.waitForEvent("requestfailed", request => request.url() === catalog)
    await page.evaluate(() => window.missionNativeFamily.transport("connected"))
    const request = await broken
    await ctx.drainRequestFailures()
    assert.equal(await page.evaluate(id => window.missionNativeFamily.panelReadCancelled(id), request.headers()[PANEL_READ_HEADER]), false)
    assert.deepEqual(ctx.failures, [`${catalog} net::ERR_ABORTED`])
    const unrelated = new URL("/api/unrelated-read-probe", url).href
    await page.route(unrelated, route => route.abort("aborted"))
    const failed = page.waitForEvent("requestfailed", request => request.url() === unrelated)
    await page.evaluate(url => fetch(url).catch(() => undefined), unrelated); await failed
    await ctx.drainRequestFailures()
    assert.deepEqual(ctx.failures, [`${catalog} net::ERR_ABORTED`, `${unrelated} net::ERR_ABORTED`])
    assert.deepEqual(ctx.errors, [])
  } finally { release(); await ctx.save(); ctx.release(); await page.close() }
})

test("deferred ordinary-child navigation cannot overwrite a newer sibling selection", { timeout: 60000 }, async () => {
  const ctx = await setup("deferred-child"), { page } = ctx
  try {
    await select(page, "A"); await pickMission(page, "A")
    await page.evaluate(() => window.missionNativeFamily.coldChild()); ctx.defer()
    await answerChild(page)
    await ctx.arrival
    await select(page, "B"); await composer(page).fill("New sibling draft")
    ctx.release()
    await ctx.completion
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await refreshMap(page)
    assert.equal(await selectedMission(page), "A", "neither the late result nor the sibling conversation changes the picked Mission")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_B")
    assert.equal(await composer(page).inputValue(), "New sibling draft")
    assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("family observation loss fences an awaited ordinary-child navigation without an error or draft mutation", { timeout: 60000 }, async () => {
  const ctx = await setup("membership-loss"), { page } = ctx
  try {
    await select(page, "A"); await pickMission(page, "A"); await composer(page).fill("Keep A during membership loss")
    await page.evaluate(() => window.missionNativeFamily.coldChild()); ctx.defer()
    await answerChild(page); await ctx.arrival
    ctx.unknown(); await refreshMap(page)
    ctx.release(); await ctx.completion
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_A")
    assert.equal(await composer(page).inputValue(), "Keep A during membership loss")
    assert.equal(await selectedMission(page), "A")
    assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("real dispatcher refreshes bounded family observations on birth, fork, move, delete and compaction but not deltas or hidden demand", { timeout: 60000 }, async () => {
  const ctx = await setup("family-event-boundaries"), { page, requests } = ctx
  const location = { directory: "/fixture" }, sessionID = "ses_born"
  const base = { id: "boundary", created: 1, location, durable: { aggregateID: sessionID, seq: 1, version: 1 as const } }
  const emit = async (event: V2Event) => {
    const response = waitForMissionPanelRefresh(page)
    await page.evaluate(serialized => window.missionNativeFamily.emit(JSON.parse(serialized) as V2Event), JSON.stringify(event))
    assert.equal((await response).status(), 200)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  }
  const count = () => requests.filter(item => item.path.endsWith("/missions") && item.source === "summaries").length
  try {
    await select(page, "A")
    ctx.setFamily({ state: "observed", members: [...observedFamily.members,
      { sessionId: sessionID, parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" }] })
    const before = count()
    await emit({ ...base, type: "session.created", data: { sessionID, parentID: "ses_actor", projectID: "project", location, slug: "born", title: "Conversation born", version: "1" } })
    ctx.setFamily({ state: "observed", members: [...observedFamily.members,
      { sessionId: sessionID, parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" },
      { sessionId: "ses_fork", parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" }] })
    await emit({ ...base, type: "session.forked", durable: { ...base.durable, aggregateID: "ses_fork", version: 2 },
      data: { sessionID: "ses_fork", parentID: "ses_actor", boundary: { type: "through", messageID: "msg_boundary" } } })
    await emit({ ...base, type: "session.compaction.started", data: { sessionID, reason: "manual" } })
    await emit({ ...base, type: "session.compaction.ended", data: { sessionID, reason: "manual", text: "bounded" } })
    ctx.unknown()
    await emit({ ...base, type: "session.moved", data: { sessionID, projectID: "project", location: { directory: "/moved" } } })
    ctx.setFamily(observedFamily)
    await emit({ ...base, type: "session.deleted", durable: { ...base.durable, version: 2 }, data: { sessionID } })
    assert.equal(count() - before, 6, "one coalesced display read per separated boundary")
    const after = count()
    await page.evaluate(event => window.missionNativeFamily.emit(event), { id: "delta", created: 1, type: "session.compaction.delta", location, data: { sessionID: "ses_grandchild", text: "not an invalidation" } } satisfies V2Event)
    await page.waitForTimeout(150)
    assert.equal(count(), after)
    await page.getByRole("tab", { name: "Status", exact: true }).click()
    await page.evaluate(event => window.missionNativeFamily.emit(event), { ...base, type: "session.deleted", durable: { ...base.durable, version: 2 }, data: { sessionID: "ses_fork" } } satisfies V2Event)
    await page.waitForTimeout(150)
    assert.equal(count(), after, "hidden Mission tab does not refresh")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})
