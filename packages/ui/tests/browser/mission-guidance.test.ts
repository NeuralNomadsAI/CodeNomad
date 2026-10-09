import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { clickMissionAction } from "./mission-actions"
import type {} from "./fixtures/mission-navigation"

let server: ViteDevServer, browser: Browser, url: string
const screenshotPath = (name: string) => path.join(tmpdir(), "opencode", `${name}-${process.env.CODENOMAD_MISSION_CAPTURE_TAG ?? "updated"}.png`)
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-guidance", configureServer(s) { s.middlewares.use("/mission-guidance", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-guidance", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-navigation.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-guidance`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const SENT = "Sent to the coordinator conversation. Being sent does not confirm it has been acted on."
function mission(id: string): MissionMap {
  const report = { id: `report-${id}`, taskKey: "xcode", sessionId: `ses_${id}`, outcome: "blocked" as const,
    summary: "Full Xcode is missing.", evidence: ["Read-only inventory"], next: ["Install Xcode"], createdAt: 1 }
  const task = { id: `task-${id}`, key: "xcode", title: "Check Xcode", brief: "Check the SDK before compiling.", role: "specialist",
    status: "needs-input" as const, blockedBy: [], outstandingExecution: false, report, createdAt: 1, updatedAt: 1 }
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "opaque-machine-notes",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [], tasks: [task,
      { ...task, id: `retired-${id}`, key: "old-apk", title: "Old cancelled build", status: "withdrawn", replacedByTaskKey: "xcode" }],
    reports: [report], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
async function setup(prepare?: (values: MissionMap[]) => void) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  page.setDefaultTimeout(15_000)
  const writes: Array<{ path: string; body: any }> = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  const values = [mission("A"), mission("B")]
  prepare?.(values)
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (request.method() !== "GET") writes.push({ path: pathname, body: request.postData() ? request.postDataJSON() : undefined })
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname.includes("/instructions/") && request.method() !== "GET") return route.fulfill({ status: 204, body: "" })
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: values, generatedAt: 1, discardedEvents: 0 } })
    if (/\/session\/ses_[AB]$/.test(pathname)) return route.fulfill({ json: { data: { id: pathname.split("/").pop(), projectID: "project",
      title: "Native coordinator", slug: "native-coordinator", version: "1", agent: "build", model: { id: "native-model", providerID: "native" }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.endsWith("/prompt")) return route.fulfill({ json: { data: { id: request.postDataJSON().id } } })
    return route.fulfill({ json: pathname.includes("/instance/") ? [] : {} })
  })
  await page.goto(url, { timeout: 60_000 })
  await select(page, "Objective A")
  return { page, values, writes, errors }
}
const row = (page: Page, title: string) => page.locator("li.mission-index-entry").filter({ has: page.getByRole("button", { name: title, exact: true }) })
const card = (page: Page) => page.locator("li.mission-index-entry-selected > div.mission-card")
/** Selecting a row is idempotent here: the selected card follows the row. */
async function select(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).click()
  await page.locator("li.mission-index-entry-selected").filter({ has: page.getByRole("button", { name: title, exact: true }) }).locator("div.mission-card").waitFor()
}
/** The single "Write to the coordinator" field is always visible in the selected running card. */
async function guidance(page: Page) {
  const form = card(page).locator("form.mission-guidance")
  await form.waitFor()
  return form
}
const field = (page: Page) => card(page).getByLabel("Write to the coordinator", { exact: true })
const send = (page: Page) => card(page).locator("form.mission-guidance").getByRole("button", { name: "Send", exact: true })

for (const mode of ["direction", "briefing"] as const) {
  test(`${mode} preparation survives session.status display revalidation without replay or profile changes`, async () => {
    const { page, writes, values, errors } = await setup()
    let releaseHydration!: () => void, hydrationStarted!: () => void, releaseDisplay!: () => void, displayStarted!: () => void
    const hydrationHold = new Promise<void>(resolve => { releaseHydration = resolve }), hydrationReached = new Promise<void>(resolve => { hydrationStarted = resolve })
    const displayHold = new Promise<void>(resolve => { releaseDisplay = resolve }), displayReached = new Promise<void>(resolve => { displayStarted = resolve })
    try {
      await page.route("**/instance/api/session/ses_A", async route => {
        hydrationStarted(); await hydrationHold
        return route.fulfill({ json: { data: { id: "ses_A", projectID: "project", title: "A", slug: "A", version: "1",
          agent: "build", model: { id: "native", providerID: "native" }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
      })
      const form = mode === "direction" ? await guidance(page) : card(page).locator(".mission-briefing-feedback")
      if (mode === "direction") {
        await field(page).fill("Keep this admitted direction through display refresh")
        await send(page).click()
      } else await clickMissionAction(row(page, "Objective A"), "Request an update")
      await hydrationReached
      await page.route("**/api/workspaces/fixture/missions", async route => {
        displayStarted(); await displayHold
        return route.fulfill({ json: { available: true, projectID: "project", missions: values, generatedAt: 1, discardedEvents: 0 } })
      })
      await page.evaluate(async () => {
        const path = "/src/lib/server-events.ts", { serverEvents } = await import(path)
        serverEvents.dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "session.status", id: "display-status", created: 1,
          location: { directory: "/fixture" }, data: { sessionID: "ses_A", status: { type: "idle" } } } }])
      })
      await displayReached
      releaseDisplay()
      await page.waitForFunction(async () => {
        const path = "/src/stores/missions.ts", { missionStore } = await import(path)
        return missionStore.state("fixture").status === "ready"
      })
      releaseHydration()
      await form.getByText(mode === "direction" ? SENT
        : "Request sent. Waiting for the coordinator to publish the briefing; sending is not a response.", { exact: true }).waitFor()
      assert.equal(writes.filter(write => write.path.endsWith("/prompt")).length, 1)
      assert.ok(!writes.some(write => /\/session\/[^/]+\/(agent|model)$|\/missions(?:\/|$)/.test(write.path)))
      assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
      assert.deepEqual(errors, [])
    } finally { releaseHydration(); releaseDisplay(); await page.close() }
  })
}
test("one visible coordinator field without modes or task selects sends only the written text to its own coordinator", async () => {
  const { page, writes, values, errors } = await setup()
  try {
    for (const removed of ["Give direction", "Ask a question"])
      assert.equal(await page.getByRole("button", { name: removed, exact: true }).count(), 0)
    const form = await guidance(page)
    assert.equal(await form.isVisible(), true)
    assert.equal(await form.getByRole("combobox").count(), 0)
    assert.equal(await form.locator("textarea").count(), 1)
    assert.equal(await field(page).getAttribute("placeholder"), "Ask a question or give a direction")
    assert.equal(await form.locator("p").count(), 0, "no status line while drafting")
    assert.equal(await send(page).isDisabled(), true)
    await field(page).fill("Use Windows verification while Xcode is unavailable.")
    await send(page).click()
    await form.getByText(SENT, { exact: true }).waitFor()
    const prompts = writes.filter(write => write.path.endsWith("/prompt"))
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].path, /\/session\/ses_A\/prompt$/)
    assert.equal(prompts[0].body.text, "Use Windows verification while Xcode is unavailable.")
    assert.equal(prompts[0].body.delivery, "steer")
    assert.equal(values[0].notes, "opaque-machine-notes")
    assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    assert.equal(writes.filter(write => /\/missions(?:\/|$)|\/session\/[^/]+\/(agent|model)$/.test(write.path)).length, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("returned blockages are results, not native questions or generic coordinator links", async () => {
  // A dependency on the retired attempt keeps it reachable through "Show dependencies".
  const { page, errors } = await setup(values => { values[0].tasks[1].blockedBy = ["xcode"] })
  try {
    assert.equal(await page.locator(".mission-needs").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Answer", exact: true }).count(), 0)
    const checklist = card(page).getByRole("region", { name: "Tasks", exact: true })
    assert.equal(await checklist.locator("h3 small").textContent(), "0/1")
    assert.equal(await checklist.locator("li[data-task-key]").count(), 1)
    assert.equal(await checklist.locator('[data-task-key="xcode"] .mission-checklist-word').textContent(), "Blocked")
    assert.equal(await checklist.getByText("Old cancelled build", { exact: true }).count(), 0)
    assert.equal(await page.locator(".mission-control").getByText("Full Xcode is missing.", { exact: true }).filter({ visible: true }).count(), 0)
    const task = checklist.getByRole("button", { name: /^Check Xcode/ })
    await task.click()
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    await page.locator(".mission-reader").getByText("Full Xcode is missing.", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByRole("button", { name: "Open coordinator", exact: true }).count(), 0)
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    assert.equal(await task.getAttribute("aria-pressed"), "false")
    await card(page).locator(".mission-more > h3 > .mission-disclosure-trigger").click()
    await card(page).getByRole("button", { name: /^Show dependencies/ }).click()
    const retired = card(page).locator('[data-task-key="old-apk"] .mission-list-item')
    assert.equal(await retired.getByRole("button", { name: "Open coordinator", exact: true }).count(), 0)
    await clickMissionAction(retired, "Read in chat area")
    await page.locator(".mission-reader").getByText("No result recorded for this task yet.", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByText("Full Xcode is missing.", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("instructions send exact text to the coordinator without selecting it, switching profiles or editing notes", async () => {
  const { page, writes, values, errors } = await setup()
  try {
    const form = await guidance(page)
    await field(page).fill("Prioritize Android tests; keep iOS preparation independent.")
    await send(page).click()
    await form.getByText(SENT, { exact: true }).waitFor()
    const prompts = writes.filter(write => write.path.endsWith("/prompt"))
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].path, /\/session\/ses_A\/prompt$/)
    assert.equal(prompts[0].body.text, "Prioritize Android tests; keep iOS preparation independent.")
    assert.equal(prompts[0].body.delivery, "steer")
    assert.ok(!writes.some(write => /\/session\/[^/]+\/(agent|model)$|\/missions(?:\/|$)/.test(write.path)))
    assert.equal(values[0].notes, "opaque-machine-notes")
    assert.equal(await field(page).inputValue(), "")
    assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    await page.screenshot({ path: screenshotPath("mission-guidance-browser"), fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("drafts survive mission switches/remount and uncertain admission is never replayed", async () => {
  const { page, writes } = await setup()
  try {
    await guidance(page)
    await field(page).fill("Instruction for A")
    await select(page, "Objective B")
    await guidance(page)
    assert.equal(await field(page).inputValue(), "")
    await field(page).fill("Instruction for B")
    await select(page, "Objective A")
    assert.equal(await field(page).inputValue(), "Instruction for A")
    let attempts = 0
    await page.route("**/session/ses_A/prompt", route => { attempts++; return route.fulfill({ status: 503, json: { error: "Lost acknowledgement" } }) })
    await send(page).click()
    await card(page).locator(".mission-guidance [role=alert]").waitFor()
    assert.equal(attempts, 1)
    assert.equal(await send(page).isDisabled(), true)
    assert.equal(await card(page).getByRole("button", { name: "Discard this draft and start a new instruction", exact: true }).isVisible(), true)
    await page.evaluate(() => { window.missionNavigation.mount(false); window.missionNavigation.mount(true) })
    // The existing panel may follow the active B conversation on remount;
    // returning to A must still preserve its independent uncertain send.
    await select(page, "Objective A")
    await guidance(page)
    assert.equal(await field(page).inputValue(), "Instruction for A")
    assert.equal(await send(page).isDisabled(), true)
    assert.equal(attempts, 1)
    assert.equal(writes.filter(write => /\/session\/[^/]+\/(agent|model)$/.test(write.path)).length, 0)
  } finally { await page.close() }
})
test("fresh paused mission fences a send before prompt admission", async () => {
  const { page, values, writes } = await setup()
  try {
    const form = await guidance(page)
    await field(page).fill("Preserve the draft")
    values[0].runState = "paused"
    await send(page).click()
    await form.getByRole("alert").waitFor()
    assert.equal(writes.filter(write => write.path.endsWith("/prompt")).length, 0)
    assert.equal(await field(page).inputValue(), "Preserve the draft")
  } finally { await page.close() }
})
test("a confirmed send after navigation settles only its original mission draft", async () => {
  const { page } = await setup()
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  try {
    await guidance(page)
    await field(page).fill("A instruction")
    await page.route("**/session/ses_A/prompt", async route => {
      reached(); await held
      await route.fulfill({ json: { data: { id: route.request().postDataJSON().id } } })
    })
    await send(page).click()
    await requested
    await select(page, "Objective B")
    await guidance(page)
    await field(page).fill("Unsent B instruction")
    release()
    await select(page, "Objective A")
    await guidance(page)
    await card(page).getByText(SENT, { exact: true }).waitFor()
    assert.equal(await field(page).inputValue(), "")
    await select(page, "Objective B")
    await guidance(page)
    assert.equal(await field(page).inputValue(), "Unsent B instruction")
  } finally { release(); await page.close() }
})
for (const transition of ["selection", "selection-aba", "inactive-aba", "directory-aba", "project-aba", "instance-aba", "remount"] as const) {
  test(`instruction preparation respects newer ${transition} and preserves the original draft`, async () => {
    const { page, writes } = await setup()
    let release!: () => void, reached!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { reached = resolve })
    try {
      await guidance(page)
      await field(page).fill("Original A instruction")
      await page.route("**/instance/api/session/ses_A", async route => {
        reached(); await held
        await route.fulfill({ json: { data: { id: "ses_A", projectID: "project", title: "A", slug: "A", version: "1",
          location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
      })
      await send(page).click()
      await requested
      if (transition.startsWith("selection")) {
        await select(page, "Objective B")
        if (transition.endsWith("aba")) await select(page, "Objective A")
      } else if (transition === "inactive-aba") {
        await page.evaluate(() => window.missionNavigation.activate(false))
        await page.evaluate(() => window.missionNavigation.activate(true))
      } else if (transition === "directory-aba") {
        await page.evaluate(() => window.missionNavigation.directory("/elsewhere"))
        await page.evaluate(() => window.missionNavigation.directory("/fixture"))
      } else if (transition === "instance-aba") {
        await page.evaluate(() => window.missionNavigation.instance("replacement"))
        await page.evaluate(() => window.missionNavigation.instance("fixture"))
      } else if (transition === "project-aba") {
        await page.evaluate(() => window.missionNavigation.project("other-project"))
        await page.evaluate(() => window.missionNavigation.project("project"))
      } else {
        await page.evaluate(() => window.missionNavigation.mount(false))
        await page.evaluate(() => window.missionNavigation.mount(true))
      }
      release()
      await select(page, "Objective A")
      await guidance(page)
      await card(page).locator(".mission-guidance [role=alert]").waitFor()
      assert.equal(await field(page).inputValue(), "Original A instruction")
      assert.equal(writes.filter(write => write.path.endsWith("/prompt")).length, 0)
      assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    } finally { release(); await page.close() }
  })
}
test("narrow coordinator instructions keep input and send action within the panel", async () => {
  const { page, errors } = await setup()
  try {
    const form = await guidance(page)
    await page.evaluate(() => { document.querySelector<HTMLElement>("#root > div")!.style.gridTemplateColumns = "minmax(0, 1fr) 280px" })
    await field(page).fill("A long draft ".repeat(120))
    const bounds = await form.boundingBox()
    assert.ok(bounds)
    for (const element of [form.locator("textarea"), send(page)]) {
      const box = await element.boundingBox()
      assert.ok(box && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1)
    }
    assert.equal(await form.evaluate(node => node.scrollWidth > node.clientWidth), false)
    await page.screenshot({ path: screenshotPath("mission-guidance-narrow"), fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
