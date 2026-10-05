import assert from "node:assert/strict"
import { after, before, test } from "node:test"
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
async function setup() {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } })
  page.setDefaultTimeout(15_000)
  const writes: Array<{ path: string; body: any }> = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  const values = [mission("A"), mission("B")]
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
  await page.getByRole("button", { name: "Objective A", exact: true }).click()
  return { page, values, writes, errors }
}
const section = (page: Page, name: string) => page.locator(".mission-disclosure", { has: page.getByRole("button", { name, exact: true }) }).last()
async function guidance(page: Page) {
  const trigger = page.getByRole("button", { name: "Instructions to the coordinator", exact: true })
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
  return page.locator(".mission-guidance")
}
test("returned blockers have detail/coordinator links; retired blockers never become native questions", async () => {
  const { page, errors } = await setup()
  try {
    assert.equal(await page.getByRole("button", { name: "Your response is needed", exact: true }).count(), 0)
    const blockages = section(page, "Reported blockages")
    await blockages.getByText("Check Xcode", { exact: true }).waitFor()
    assert.equal(await blockages.getByText("Old cancelled build", { exact: true }).count(), 0)
    await clickMissionAction(blockages.locator(".mission-list-item"), "Read in chat area")
    await page.locator(".mission-reader").getByText("Full Xcode is missing.", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByRole("button", { name: "Open coordinator", exact: true }).click()
    await page.waitForFunction(() => window.missionNavigation.snapshot().selectedSession === "ses_A")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await clickMissionAction(page.locator('[data-task-key="old-apk"] .mission-list-item'), "Open coordinator")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("instructions send exact text to the coordinator without selecting it, switching profiles or editing notes", async () => {
  const { page, writes, values, errors } = await setup()
  try {
    const form = await guidance(page)
    await form.getByLabel("Your instruction", { exact: true }).fill("Prioritize Android tests; keep iOS preparation independent.")
    await form.getByRole("button", { name: "Send to coordinator", exact: true }).click()
    await form.getByText("Sent to the coordinator conversation. Being sent does not confirm it has been acted on.", { exact: true }).waitFor()
    const prompts = writes.filter(write => write.path.endsWith("/prompt"))
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].path, /\/session\/ses_A\/prompt$/)
    assert.equal(prompts[0].body.text, "Prioritize Android tests; keep iOS preparation independent.")
    assert.equal(prompts[0].body.delivery, "steer")
    assert.ok(!writes.some(write => /\/session\/[^/]+\/(agent|model)$|\/missions(?:\/|$)/.test(write.path)))
    assert.equal(values[0].notes, "opaque-machine-notes")
    assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "")
    assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    await page.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/opencode/mission-guidance-browser.png", fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("drafts survive mission switches/remount and uncertain admission is never replayed", async () => {
  const { page, writes } = await setup()
  try {
    let form = await guidance(page)
    await form.getByLabel("Your instruction", { exact: true }).fill("Instruction for A")
    await page.getByRole("button", { name: "Objective B", exact: true }).click()
    form = await guidance(page)
    assert.equal(await form.getByLabel("Your instruction", { exact: true }).inputValue(), "")
    await form.getByLabel("Your instruction", { exact: true }).fill("Instruction for B")
    await page.getByRole("button", { name: "Objective A", exact: true }).click()
    assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "Instruction for A")
    let attempts = 0
    await page.route("**/session/ses_A/prompt", route => { attempts++; return route.fulfill({ status: 503, json: { error: "Lost acknowledgement" } }) })
    await page.getByRole("button", { name: "Send to coordinator", exact: true }).click()
    await page.locator(".mission-guidance [role=alert]").waitFor()
    assert.equal(attempts, 1)
    assert.equal(await page.getByRole("button", { name: "Send to coordinator", exact: true }).isDisabled(), true)
    await page.evaluate(() => { window.missionNavigation.mount(false); window.missionNavigation.mount(true) })
    // The existing panel may follow the active B conversation on remount;
    // returning to A must still preserve its independent uncertain send.
    await page.getByRole("button", { name: "Objective A", exact: true }).click()
    await guidance(page)
    assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "Instruction for A")
    assert.equal(await page.getByRole("button", { name: "Send to coordinator", exact: true }).isDisabled(), true)
    assert.equal(attempts, 1)
    assert.equal(writes.filter(write => /\/session\/[^/]+\/(agent|model)$/.test(write.path)).length, 0)
  } finally { await page.close() }
})
test("fresh paused mission fences a send before prompt admission", async () => {
  const { page, values, writes } = await setup()
  try {
    const form = await guidance(page)
    await form.getByLabel("Your instruction", { exact: true }).fill("Preserve the draft")
    values[0].runState = "paused"
    await form.getByRole("button", { name: "Send to coordinator", exact: true }).click()
    await form.getByRole("alert").waitFor()
    assert.equal(writes.filter(write => write.path.endsWith("/prompt")).length, 0)
    assert.equal(await form.getByLabel("Your instruction", { exact: true }).inputValue(), "Preserve the draft")
  } finally { await page.close() }
})
test("a confirmed send after navigation settles only its original mission draft", async () => {
  const { page } = await setup()
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  try {
    await guidance(page)
    await page.getByLabel("Your instruction", { exact: true }).fill("A instruction")
    await page.route("**/session/ses_A/prompt", async route => {
      reached(); await held
      await route.fulfill({ json: { data: { id: route.request().postDataJSON().id } } })
    })
    await page.getByRole("button", { name: "Send to coordinator", exact: true }).click()
    await requested
    await page.getByRole("button", { name: "Objective B", exact: true }).click()
    await guidance(page)
    await page.getByLabel("Your instruction", { exact: true }).fill("Unsent B instruction")
    release()
    await page.getByRole("button", { name: "Objective A", exact: true }).click()
    await guidance(page)
    await page.getByText("Sent to the coordinator conversation. Being sent does not confirm it has been acted on.", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "")
    await page.getByRole("button", { name: "Objective B", exact: true }).click()
    await guidance(page)
    assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "Unsent B instruction")
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
      await page.getByLabel("Your instruction", { exact: true }).fill("Original A instruction")
      await page.route("**/instance/api/session/ses_A", async route => {
        reached(); await held
        await route.fulfill({ json: { data: { id: "ses_A", projectID: "project", title: "A", slug: "A", version: "1",
          location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
      })
      await page.getByRole("button", { name: "Send to coordinator", exact: true }).click()
      await requested
      if (transition.startsWith("selection")) {
        await page.getByRole("button", { name: "Objective B", exact: true }).click()
        if (transition.endsWith("aba")) await page.getByRole("button", { name: "Objective A", exact: true }).click()
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
      await page.getByRole("button", { name: "Objective A", exact: true }).click()
      await guidance(page)
      await page.locator(".mission-guidance [role=alert]").waitFor()
      assert.equal(await page.getByLabel("Your instruction", { exact: true }).inputValue(), "Original A instruction")
      assert.equal(writes.filter(write => write.path.endsWith("/prompt")).length, 0)
      assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    } finally { release(); await page.close() }
  })
}
test("narrow coordinator instructions keep the input and both actions within the panel", async () => {
  const { page, errors } = await setup()
  try {
    await guidance(page)
    await page.evaluate(() => { document.querySelector<HTMLElement>("#root > div")!.style.gridTemplateColumns = "minmax(0, 1fr) 280px" })
    const form = page.locator(".mission-guidance")
    await form.getByLabel("Your instruction", { exact: true }).fill("A long draft ".repeat(120))
    const bounds = await form.boundingBox()
    assert.ok(bounds)
    for (const element of [form.locator("textarea"), form.getByRole("button", { name: "Send to coordinator", exact: true }),
      form.getByRole("button", { name: "Open coordinator", exact: true })]) {
      const box = await element.boundingBox()
      assert.ok(box && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1)
    }
    assert.equal(await form.evaluate(node => node.scrollWidth > node.clientWidth), false)
    await page.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/opencode/mission-guidance-narrow.png", fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
