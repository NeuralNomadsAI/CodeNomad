import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { chromium, type Browser, type Page, type Request } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionActivityProjection } from "../../../server/src/api-types"
import type { V2Event, SessionMessageUser } from "@opencode/client"
import { outlineInputSchema, outlineResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema,
  navigationWindowInputSchema, navigationWindowResultSchema } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-native-family"

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
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() }; console.info(`Family fixture logs: ${output}`) })
function mission(id: string, independent = false): MissionMap {
  const actor = (name: string, kind: "coordinator" | "specialist") => ({ sessionId: `ses_${name}`, kind, managed: false,
    title: `Declared ${name}`, roles: [kind], location: { directory: "/fixture" }, joinedAt: 1 })
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: id === "A" ? [actor("A", "coordinator"), actor("actor", "specialist"), ...(independent ? [actor("independent", "specialist")] : [])] : [actor("B", "coordinator")],
    tasks: [], reports: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
const observedFamily: NonNullable<MissionActivityProjection["missions"][number]["family"]> = { state: "observed", members: [
  { sessionId: "ses_A", actorSessionId: "ses_A", kind: "declared" },
  { sessionId: "ses_actor", parentSessionId: "ses_A", actorSessionId: "ses_actor", kind: "declared" },
  { sessionId: "ses_child", parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_grandchild", parentSessionId: "ses_child", actorSessionId: "ses_actor", kind: "ordinary" },
] }
const deepFamily: typeof observedFamily = { state: "observed", members: [...observedFamily.members,
  { sessionId: "ses_third", parentSessionId: "ses_grandchild", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_fourth", parentSessionId: "ses_third", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_fifth", parentSessionId: "ses_fourth", actorSessionId: "ses_actor", kind: "ordinary" },
  { sessionId: "ses_independent", actorSessionId: "ses_independent", kind: "declared" },
].reverse() }
function nativeHistory(sessionId: string): SessionMessageUser[] {
  assert.match(sessionId, /^ses_[A-Za-z_]+$/)
  return [1, 2].map(n => ({ id: `msg_${sessionId}_${n}`, type: "user", time: { created: n }, text: `Bounded native history ${sessionId} ${n}` }))
}
async function setup(label: string, narrow = false, independent = false) {
  const page = await browser.newPage({ locale: narrow ? "he-IL" : "en-US", viewport: narrow ? { width: 390, height: 600 } : { width: 1600, height: 950 },
    hasTouch: narrow, deviceScaleFactor: 1 })
  page.setDefaultTimeout(12000)
  const errors: string[] = [], failures: string[] = [], consoleErrors: string[] = [], requests: Array<{ method: string; path: string; body?: unknown }> = []
  const voidResponses = new Set<Request>(), voidBodyCancellations: string[] = []
  const rawRequestFailures: string[] = [], navigationReadCancellations: Array<{ failure: string; requestedSession: string; activeSession: string }> = []
  const failureChecks: Promise<void>[] = []
  const drainRequestFailures = async () => { await Promise.all(failureChecks) }
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
    rawRequestFailures.push(message)
    // The actual Promise client cancels empty-response bodies. Retain these
    // confirmed 204 receipts separately, never excuse an unconfirmed failure.
    if (voidResponses.has(request) && request.failure()?.errorText === "net::ERR_ABORTED") voidBodyCancellations.push(message)
    else if (request.method() === "POST" && new URL(request.url()).pathname === "/api/workspaces/native-family/session-history/outlinePreview"
      && request.failure()?.errorText === "net::ERR_ABORTED") {
      // Production timeline-previews.ts aborts demand on session/inactive
      // cleanup. Verify the exact old-session request before classifying it;
      // retain the raw failure and never count an abort as a response receipt.
      const requestedSession = outlinePreviewInputSchema.parse(request.postDataJSON()).sessionID
      failureChecks.push(page.evaluate(() => window.missionNativeFamily?.snapshot().session).then(activeSession => {
        if (activeSession && activeSession !== requestedSession) navigationReadCancellations.push({ failure: message, requestedSession, activeSession })
        else failures.push(message)
      }).catch(() => { failures.push(message) }))
    } else failures.push(message)
  })
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, location = { directory: "/fixture" }
    requests.push({ method: request.method(), path: pathname, ...(request.postData() ? { body: request.postDataJSON() } : {}) })
    if (pathname === "/api/events") return route.continue()
    if (pathname === "/api/storage/config/ui") return route.fulfill({ json: { settings: { locale: narrow ? "he" : "en", showMessageTimeline: true } } })
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
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission("A", independent), mission("B")], generatedAt: 1, discardedEvents: 0,
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
    await writeFile(path.join(output, `${label}.json`), JSON.stringify({ transport: "isolated-http-fakes", errors, failures, consoleErrors, rawRequestFailures, navigationReadCancellations, voidBodyCancellations, requests, receipts, fallbackResponses,
      apiCounts: Object.fromEntries([...new Set(requests.map(item => `${item.method} ${item.path}`))].map(key => [key, requests.filter(item => `${item.method} ${item.path}` === key).length])),
      snapshot: await page.evaluate(() => window.missionNativeFamily?.snapshot()).catch(() => null),
      openGates: ["live authenticated HTTP/SSE desktop host", "invocation profile provenance"] }, null, 2))
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true }).catch(() => {})
  }
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); await page.waitForFunction(() => window.missionNativeFamily?.snapshot().session === "ses_B", undefined, { timeout: 30000 });
    if (!narrow) await page.waitForFunction(() => window.missionNativeFamily.snapshot().selectedMission === "B") }
  catch (error) { await save(); release(); await page.close(); throw error }
  return { page, errors, failures, requests, save, drainRequestFailures, arrival, completion, release, defer: () => { deferred = true },
    setFamily: (next: typeof observedFamily) => { family = next },
    unknown: () => { family = { state: "unknown", members: observedFamily.members } } }
}
const composer = (page: Page) => page.locator("textarea.prompt-input:visible")
async function select(page: Page, id: string) {
  const row = page.locator(`.session-sidebar [data-session-id="ses_${id}"]`)
  await row.locator(".session-item-select").click()
  await page.waitForFunction(id => window.missionNativeFamily.snapshot().session === `ses_${id}`, id)
}
async function expand(page: Page, id: string) {
  const button = page.locator(`.session-sidebar [data-session-id="ses_${id}"] .session-item-expander`)
  if (await button.getAttribute("aria-expanded") !== "true") await button.click()
}
async function conversations(page: Page) {
  const details = page.getByRole("button", { name: /^(Technical details|פרטים טכניים)$/ })
  if (await details.getAttribute("aria-expanded") !== "true") await details.click()
  assert.equal(await details.getAttribute("aria-expanded"), "true")
  const button = page.locator(".mission-disclosure-trigger").filter({ hasText: /Conversations|שיחות/ }).first()
  if (await button.getAttribute("aria-expanded") !== "true") await button.click()
  assert.equal(await button.getAttribute("aria-expanded"), "true")
}

test("production SessionList/SessionView select recursive children, steer/queue only that child and preserve coordinator/sibling drafts", { timeout: 60000 }, async () => {
  const ctx = await setup("child-steer-queue"), { page, requests } = ctx
  try {
    await composer(page).fill("Sibling B draft")
    await select(page, "A"); await composer(page).fill("Coordinator A draft")
    await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await select(page, "B")
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().selectedMission === "B")
    await select(page, "grandchild")
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().selectedMission === "A")
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
    await conversations(page)
    assert.equal(await page.locator('[data-family-kind="ordinary"]').count(), 2)
    assert.equal(await page.locator('[data-family-kind="ordinary"] .mission-activity-assignment').count(), 0)
    assert.equal(await page.locator('[data-family-kind="ordinary"][data-session-id="ses_grandchild"]').getAttribute("data-native-parent-id"), "ses_child")
    assert.equal(await page.locator('[data-family-kind="ordinary"][data-session-id="ses_grandchild"]').getAttribute("data-declared-actor-id"), "ses_actor")
    assert(await page.locator('[data-family-kind="ordinary"] .mission-activity-copy').first().evaluate(element => element.getBoundingClientRect().width > 100))
    await page.screenshot({ path: path.join(output, "ordinary-descendants.png"), fullPage: true })
    await page.locator('[data-family-kind="ordinary"][data-session-id="ses_child"] > .mission-activity-actor').getByRole("button").click()
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_child")
    await select(page, "A"); assert.equal(await composer(page).inputValue(), "Coordinator A draft")
    await select(page, "B"); assert.equal(await composer(page).inputValue(), "Sibling B draft")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

const conversationRow = (page: Page, id: string) => page.locator(`.mission-conversation-node[data-session-id="ses_${id}"] > .mission-activity-actor`)
async function assertConversationGeometry(page: Page, rtl: boolean) {
  const geometry = await page.locator(".mission-activity-list").evaluate(list => {
    const nodes = [...list.querySelectorAll<HTMLElement>(".mission-conversation-node")]
    return nodes.map(node => {
      const row = node.querySelector<HTMLElement>(":scope > .mission-activity-actor")!
      const text = row.querySelector<HTMLElement>(".mission-list-text")!, status = row.querySelector<HTMLElement>(".mission-list-footer")!
      const parent = node.parentElement!.closest<HTMLElement>(".mission-conversation-node")
      const r = row.getBoundingClientRect(), t = text.getBoundingClientRect(), s = status.getBoundingClientRect()
      return { id: node.dataset.sessionId, parent: parent?.dataset.sessionId, x: r.x, right: r.right, width: r.width,
        y: r.y, bottom: r.bottom, textBottom: t.bottom, statusY: s.y, radius: getComputedStyle(row.querySelector(".mission-list-item")!).borderRadius,
        overflow: row.scrollWidth > row.clientWidth + 1 }
    })
  })
  assert.deepEqual(geometry.map(row => row.id), ["ses_A", "ses_actor", "ses_child", "ses_grandchild", "ses_third", "ses_fourth", "ses_fifth", "ses_independent"])
  assert.equal(geometry.length, 8)
  assert.equal(geometry[0].parent, undefined); assert.equal(geometry.at(-1)!.parent, undefined)
  for (let index = 1; index < 7; index++) {
    const row = geometry[index], parent = geometry[index - 1]
    assert.equal(row.parent, parent.id, "semantic nested list matches native ancestry")
    assert(rtl ? row.right < parent.right : row.x > parent.x, "logical indentation follows native parent")
    assert(row.y >= parent.bottom - 1, "children follow their parent's row")
    assert(row.width > 100, "deep conversations remain usable without a display depth ceiling")
  }
  for (const row of geometry) {
    assert.equal(row.radius, "0px"); assert.equal(row.overflow, false)
    assert(row.statusY >= row.textBottom - 1, "status/actions occupy the third line")
  }
  return geometry
}

test("Conversations shows distinct native hierarchy and independent roots; descendant events update only exact honest status", { timeout: 60000 }, async () => {
  const ctx = await setup("conversations-hierarchy", false, true), { page } = ctx
  try {
    await select(page, "A"); await conversations(page)
    assert.equal(await page.locator('.mission-disclosure-trigger').filter({ hasText: "Conversations" }).locator("small").innerText(), "8")
    const geometry = await assertConversationGeometry(page, false)
    await writeFile(path.join(output, "conversations-hierarchy.geometry.json"), JSON.stringify(geometry, null, 2))
    assert.match(await conversationRow(page, "A").innerText(), /Family observation: Running/)
    const focused = conversationRow(page, "child").getByRole("button", { name: "Open Conversation child", exact: true })
    const retained = await focused.elementHandle()
    assert(retained)
    await focused.focus()
    const revalidated = page.waitForResponse(response => response.url().endsWith("/missions"))
    await page.evaluate(() => window.missionNativeFamily.emit({ id: "declared-child-idle", created: 2, type: "session.status", location: { directory: "/fixture" },
      data: { sessionID: "ses_actor", status: { type: "idle" } } } satisfies V2Event))
    await revalidated
    await conversationRow(page, "actor").locator('[data-state="idle"]').waitFor()
    assert.equal(await retained.evaluate(button => button.isConnected && document.activeElement === button), true,
      "fresh family snapshots preserve the exact conversation action and keyboard focus")
    assert.equal(await conversationRow(page, "actor").getByText("Family observation: Running", { exact: true }).count(), 0)
    await page.evaluate(() => window.missionNativeFamily.emit({ id: "exact-idle", created: 2, type: "session.status", location: { directory: "/fixture" },
      data: { sessionID: "ses_child", status: { type: "idle" } } } satisfies V2Event))
    await conversationRow(page, "child").locator('[data-state="idle"]').waitFor()
    assert.equal(await conversationRow(page, "child").getByText("Idle", { exact: true }).count(), 1)
    assert.equal(await conversationRow(page, "child").getByText("Running", { exact: true }).count(), 0)
    await page.evaluate(() => window.missionNativeFamily.statusKnown("ses_child", false))
    await conversationRow(page, "child").locator('[data-state="unknown"]').waitFor()
    await page.evaluate(() => window.missionNativeFamily.emit({ id: "exact-running", created: 3, type: "session.status", location: { directory: "/fixture" },
      data: { sessionID: "ses_fifth", status: { type: "running" } } } satisfies V2Event))
    await conversationRow(page, "fifth").locator('[data-state="running"]').waitFor()
    assert.equal(await conversationRow(page, "child").locator('[data-state="unknown"]').count(), 1)
    await page.evaluate(() => window.missionNativeFamily.ask())
    await conversationRow(page, "grandchild").locator('[data-state="form"]').waitFor()
    await page.evaluate(() => window.missionNativeFamily.askPermission())
    await conversationRow(page, "grandchild").locator('[data-state="permission"]').waitFor()
    await conversationRow(page, "fifth").getByRole("button", { name: "Open Conversation fifth", exact: true }).click()
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().session === "ses_fifth")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).root, "ses_A")
    await conversationRow(page, "independent").getByRole("button", { name: "Open Declared independent", exact: true }).click()
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().session === "ses_independent")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).root, "ses_independent")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).selectedMission, "A")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("390px RTL touch Conversations retains recursive geometry, semantic ancestry and exact child navigation", { timeout: 60000 }, async () => {
  const ctx = await setup("conversations-rtl-touch", true, true), { page } = ctx
  try {
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    await page.locator(".session-header-drawer-toggle--left button:visible").tap()
    await select(page, "A")
    await page.locator('.session-sidebar-header-actions:visible button').last().tap()
    await page.locator(".session-header-drawer-toggle--right button:visible").tap()
    await conversations(page)
    assert.equal(await page.locator('.mission-disclosure-trigger').filter({ hasText: "שיחות" }).locator("small").innerText(), "8")
    const geometry = await assertConversationGeometry(page, true)
    await writeFile(path.join(output, "conversations-rtl-touch.geometry.json"), JSON.stringify(geometry, null, 2))
    await conversationRow(page, "fifth").scrollIntoViewIfNeeded()
    await writeFile(path.join(output, "conversations-rtl-touch.actions.json"), JSON.stringify(await conversationRow(page, "fifth").evaluate(row => ({
      html: row.outerHTML, ancestors: [...function* () { let node: Element | null = row; while (node) { yield { tag: node.tagName, classes: node.className, hidden: node.getAttribute("aria-hidden"), inert: node.hasAttribute("inert") }; node = node.parentElement } }()],
    })), null, 2))
    const button = conversationRow(page, "fifth").getByRole("button")
    const box = await button.boundingBox(); assert(box && box.width >= 24 && box.height >= 24)
    await button.tap()
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().session === "ses_fifth")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).root, "ses_A")
    assert.equal(await page.locator('.mission-activity-list [role="tree"]').count(), 0)
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
    assert.equal(measurement.helperFocusIndex, 0, "overflow help remains keyboard accessible")
    assert(measurement.helperHitTesting, "actual helper receives pointer hits in its reserved strip")
    assert(measurement.helperDescription, "textarea retains a semantic reference to all helper content")
  }
  return measurement
}

test("desktop child/grandchild composer keeps the real visible help separate from native placeholder/text at zoom 1", { timeout: 60000 }, async () => {
  const ctx = await setup("visual-desktop"), { page } = ctx
  try {
    await select(page, "A"); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    for (const id of ["child", "grandchild"]) {
      await select(page, id)
      await page.getByText(`Bounded native history ses_${id} 2`, { exact: true }).waitFor()
      await page.locator(`.message-timeline-segment[data-message-id="msg_ses_${id}_1"]:visible`).waitFor()
      assert.equal(await page.getByText("Full timeline unavailable", { exact: true }).count(), 0)
      const empty = await captureComposer(page, `desktop-${id}-empty`, `ses_${id}`)
      assert(empty.overlay, "desktop help must remain visibly present, not hidden to pass")
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
      const toggle = page.locator(".session-header-drawer-toggle--left button:visible")
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.tap()
    }
    await openSessions(); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    for (const id of ["child", "grandchild"]) {
      await openSessions(); await select(page, id)
      await page.locator('.session-sidebar-header-actions:visible button').last().tap()
      await page.getByText(`Bounded native history ses_${id} 2`, { exact: true }).waitFor()
      const empty = await captureComposer(page, `rtl-touch-${id}-empty`, `ses_${id}`)
      assert.equal(empty.overlay, null, "production coarse-pointer CSS suppresses keyboard-only help")
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

test("44px desktop floor keeps real helper content visible, scrollable and described without changing width/draft-independent limits", { timeout: 60000 }, async () => {
  const ctx = await setup("helper-44px-floor"), { page } = ctx
  try {
    await select(page, "A"); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await select(page, "grandchild")
    await page.setViewportSize({ width: 1600, height: 390 })
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>("textarea.prompt-input")]
      .some(node => node.getBoundingClientRect().height === 44))
    const empty = await captureComposer(page, "desktop-grandchild-44px-empty", "ses_grandchild")
    assert.equal(empty.textarea.height, 44); assert(empty.overlay); assert(empty.helperScrollable)
    const help = page.locator(".prompt-input-overlay:visible")
    assert.match(await help.innerText(), /Send/); assert.match(await help.innerText(), /Commands/)
    assert.match(await help.innerText(), /Reference project files/)
    assert.equal(await composer(page).getAttribute("aria-describedby"), await help.getAttribute("id"))
    await help.focus(); for (let n = 0; n < 5; n++) await page.keyboard.press("ArrowRight")
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".prompt-input-overlay")].some(node => node.scrollLeft > 0))
    await page.screenshot({ path: path.join(output, "desktop-grandchild-44px-helper-scrolled.png"), fullPage: false })
    const resize = page.locator(".prompt-resize-handle:visible")
    assert.equal(Number(await resize.getAttribute("aria-valuemin")), 44)
    assert.equal(Number(await resize.getAttribute("aria-valuemax")), 234)
    await composer(page).fill(Array.from({ length: 30 }, (_, n) => `Draft line ${n}`).join("\n"))
    assert.equal(await composer(page).evaluate(node => node.getBoundingClientRect().height), 44)
    assert(await composer(page).evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === "auto"))
    await composer(page).fill("")
    await captureComposer(page, "desktop-grandchild-44px-restored", "ses_grandchild")
    // The main captures positively require visible help. Separately preserve
    // the shell's existing opt-out, which must not reserve an invisible strip.
    await page.evaluate(() => { document.documentElement.dataset.keyboardHints = "hide" })
    assert.equal(await help.isVisible(), false)
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
    await page.locator(".session-header-drawer-toggle--left button:visible").tap()
    await expand(page, "A"); await expand(page, "actor"); await select(page, "child")
    await page.locator('.session-sidebar-header-actions:visible button').last().tap()
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
    await select(page, "A"); await page.evaluate(() => window.missionNativeFamily.ask())
    const attention = page.locator(".mission-attention-list")
    await attention.getByText("Child choice", { exact: true }).waitFor()
    assert.equal(await attention.getByText("Global choice", { exact: true }).count(), 0)
    await attention.getByRole("button", { name: "Open ses_grandchild", exact: true }).click()
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_grandchild")
    const form = page.locator(".interruption-dock").getByRole("form", { name: "Child choice", exact: true })
    await form.locator('input[type="text"]').fill("Answer through native dock")
    const receipt = page.waitForResponse(response => response.url().endsWith("/form/child-question/reply") && response.request().method() === "POST")
    await form.locator('button[type="submit"]').click(); assert.equal((await receipt).status(), 204)
    await form.waitFor({ state: "detached" })
    const replies = requests.filter(item => item.path.includes("/form/") && item.method !== "GET")
    assert.equal(replies.length, 1); assert(replies[0].path.includes("/session/ses_grandchild/"))
    await page.evaluate(() => window.missionNativeFamily.askPermission())
    await attention.getByText("safe-fixture.txt", { exact: true }).waitFor()
    assert.equal(await attention.getByText("global-fixture.txt", { exact: true }).count(), 0)
    // Upstream's dock retains its selected request instead of automatically
    // selecting a newly enqueued permission. Target the exact attention action.
    await attention.getByRole("button", { name: "Open ses_grandchild", exact: true }).click()
    await page.locator(".interruption-dock").getByRole("button", { name: "Allow Once", exact: true }).waitFor()
    assert((await page.locator(".interruption-dock").innerText()).includes("safe-fixture.txt"))
    const permissionReceipt = page.waitForResponse(response => response.url().includes("child-permission") && response.request().method() !== "GET")
    await page.locator(".interruption-dock").getByRole("button", { name: "Allow Once", exact: true }).click()
    assert.equal((await permissionReceipt).status(), 204)
    await attention.getByText("safe-fixture.txt", { exact: true }).waitFor({ state: "detached" })
    const permissionReplies = requests.filter(item => item.path.includes("child-permission") && item.method !== "GET")
    assert.equal(permissionReplies.length, 1); assert(permissionReplies[0].path.includes("/session/ses_grandchild/"))
    await conversations(page); assert.equal(await page.locator('[data-family-kind="ordinary"]').count(), 2)
    ctx.unknown(); await page.getByRole("button", { name: "Refresh mission map", exact: true }).click()
    await page.getByText("Native family unknown; only declared actors are shown.", { exact: true }).waitFor()
    assert.equal(await page.locator('[data-family-kind="ordinary"]').count(), 0)
    assert.equal(await page.locator(".mission-activity-actor").count(), 2)
    await select(page, "B"); await select(page, "grandchild")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).selectedMission, "B", "local ancestry does not replace an unknown family observation")
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("390px RTL Attention selects the exact same-active-child permission before closing its owned drawer", { timeout: 60000 }, async () => {
  const ctx = await setup("attention-same-child-rtl", true), { page, requests } = ctx
  try {
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    await page.locator(".session-header-drawer-toggle--left button:visible").tap()
    await select(page, "A"); await expand(page, "A"); await expand(page, "actor"); await expand(page, "child")
    await select(page, "grandchild")
    await page.locator('.session-sidebar-header-actions:visible button').last().tap()
    await page.evaluate(() => window.missionNativeFamily.askPermission())
    await page.locator('.interruption-dock .interruption-navigation button').filter({ has: page.locator('svg.lucide-chevron-right') }).tap()
    await page.waitForFunction(() => document.querySelector(".interruption-dock")?.textContent?.includes("global-fixture.txt"))
    await page.locator(".session-header-drawer-toggle--right button:visible").tap()
    const attention = page.locator(".mission-attention-list")
    await attention.getByText("safe-fixture.txt", { exact: true }).waitFor()
    await attention.getByRole("button", { name: /ses_grandchild/ }).tap()
    await page.waitForFunction(() => document.querySelector(".interruption-dock")?.textContent?.includes("safe-fixture.txt"))
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_grandchild")
    await page.locator(".session-floating-drawer:visible").waitFor({ state: "detached" })
    assert.equal((await page.locator(".interruption-dock").innerText()).includes("global-fixture.txt"), false)
    assert.equal(requests.filter(item => item.path.includes("permission") && item.method !== "GET").length, 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("deferred ordinary-child navigation cannot overwrite a newer sibling selection", { timeout: 60000 }, async () => {
  const ctx = await setup("deferred-child"), { page } = ctx
  try {
    await select(page, "A"); await conversations(page)
    await page.evaluate(() => window.missionNativeFamily.coldChild()); ctx.defer()
    await page.locator('[data-family-kind="ordinary"][data-session-id="ses_child"] > .mission-activity-actor').getByRole("button").click()
    await ctx.arrival
    await select(page, "B"); await composer(page).fill("New sibling draft")
    ctx.release()
    await ctx.completion
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).click()
    await page.waitForFunction(() => window.missionNativeFamily.snapshot().selectedMission === "B")
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_B")
    assert.equal(await composer(page).inputValue(), "New sibling draft")
    assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("family observation loss fences an awaited ordinary-child navigation without an error or draft mutation", { timeout: 60000 }, async () => {
  const ctx = await setup("membership-loss"), { page } = ctx
  try {
    await select(page, "A"); await composer(page).fill("Keep A during membership loss"); await conversations(page)
    await page.evaluate(() => window.missionNativeFamily.coldChild()); ctx.defer()
    await page.locator('[data-family-kind="ordinary"][data-session-id="ses_child"] > .mission-activity-actor').getByRole("button").click(); await ctx.arrival
    ctx.unknown(); await page.getByRole("button", { name: "Refresh mission map", exact: true }).click()
    await page.getByText("Native family unknown; only declared actors are shown.", { exact: true }).waitFor()
    ctx.release(); await ctx.completion
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal((await page.evaluate(() => window.missionNativeFamily.snapshot())).session, "ses_A")
    assert.equal(await composer(page).inputValue(), "Keep A during membership loss")
    assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    await ctx.drainRequestFailures(); assert.deepEqual(ctx.errors, []); assert.deepEqual(ctx.failures, [])
  } finally { await ctx.save(); ctx.release(); await page.close() }
})

test("real dispatcher refreshes bounded family observations on birth, fork, move, delete and compaction but not deltas or hidden demand", { timeout: 60000 }, async () => {
  const ctx = await setup("family-event-boundaries"), { page, requests } = ctx
  const location = { directory: "/fixture" }, sessionID = "ses_born"
  const base = { id: "boundary", created: 1, location, durable: { aggregateID: sessionID, seq: 1, version: 1 as const } }
  const emit = async (event: V2Event) => {
    const response = page.waitForResponse(response => response.url().endsWith("/missions"))
    await page.evaluate(serialized => window.missionNativeFamily.emit(JSON.parse(serialized) as V2Event), JSON.stringify(event))
    assert.equal((await response).status(), 200)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  }
  const count = () => requests.filter(item => item.path.endsWith("/missions")).length
  try {
    await select(page, "A"); await conversations(page)
    ctx.setFamily({ state: "observed", members: [...observedFamily.members,
      { sessionId: sessionID, parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" }] })
    const before = count()
    await emit({ ...base, type: "session.created", data: { sessionID, parentID: "ses_actor", projectID: "project", location, slug: "born", title: "Conversation born", version: "1" } })
    await page.locator('[data-family-kind="ordinary"][data-session-id="ses_born"]').waitFor()
    ctx.setFamily({ state: "observed", members: [...observedFamily.members,
      { sessionId: sessionID, parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" },
      { sessionId: "ses_fork", parentSessionId: "ses_actor", actorSessionId: "ses_actor", kind: "ordinary" }] })
    await emit({ ...base, type: "session.forked", durable: { ...base.durable, aggregateID: "ses_fork", version: 2 },
      data: { sessionID: "ses_fork", parentID: "ses_actor", boundary: { type: "through", messageID: "msg_boundary" } } })
    await page.locator('[data-family-kind="ordinary"][data-session-id="ses_fork"]').waitFor()
    await emit({ ...base, type: "session.compaction.started", data: { sessionID, reason: "manual", recent: "" } })
    await emit({ ...base, type: "session.compaction.ended", data: { sessionID, reason: "manual", recent: "", text: "bounded" } })
    ctx.unknown()
    await emit({ ...base, type: "session.moved", data: { sessionID, projectID: "project", location: { directory: "/moved" } } })
    await page.getByText("Native family unknown; only declared actors are shown.", { exact: true }).waitFor()
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
