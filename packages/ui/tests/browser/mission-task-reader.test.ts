import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
      logLevel: "error", plugins: [shutdown.plugin, solid(), { name: "mission-task-reader", configureServer(s) {
        s.middlewares.use("/mission-task-reader", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/mission-task-reader", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-task-reader.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-task-reader`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const long = (name: string) => `${name} ${"content ".repeat(2200)} ${name}_TAIL`
const nativeSession = (id: string) => ({ id, projectID: "project", title: id, slug: id, version: "1",
  ...(id === "actor" ? { parentID: "native-parent" } : {}), location: { directory: "/fixture/native-worktree" },
  time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
function mission(): MissionMap {
  const binding = { generation: 1, parentSessionID: "coordinator", parentMessageID: "parent-message", toolCallID: "native-call" }
  const report: MissionReport = { id: "report", taskKey: "work", sessionId: "coordinator", createdAt: 2, outcome: "completed",
    summary: long("SUMMARY"), evidence: [long("EVIDENCE")], next: [long("NEXT")], artifact: { content: long("ARTIFACT") }, delivery: "coordinator-readout" }
  const task: MissionTask = { id: "task", key: "work", title: "Work title", brief: long("BRIEF"), role: "implementer", status: "completed",
    blockedBy: ["before"], actorSessionId: "actor", execution: { agent: "requested-agent", model: { providerID: "openai", id: "requested-model", variant: "high" } },
    executionMode: { kind: "native", parentTaskKey: null }, nativeBinding: binding, nativeExecution: { binding, launch: { mode: "foreground", state: "called" } },
    contractGeneration: 1, report, outstandingExecution: true, createdAt: 1, updatedAt: 2 }
  return { version: 1, id: "mission", projectID: "project", projectCanonical: "/fixture", objective: "Objective", template: "custom",
    coordinatorSessionId: "coordinator", status: "active", actors: ["actor", "coordinator"].map(sessionId => ({ sessionId, title: sessionId === "actor" ? "Native actor" : "Coordinator",
      kind: sessionId === "actor" ? "specialist" : "coordinator", managed: true, roles: ["implementer"], location: { directory: "/fixture" }, joinedAt: 1 })),
    frontier: [], claims: [], revision: 2, createdAt: 1, updatedAt: 2,
    tasks: [{ ...task, id: "before", key: "before", title: "Earlier task", brief: "Earlier brief", blockedBy: [], status: "withdrawn", replacedByTaskKey: "work", report: undefined },
      { ...task, replacesTaskKey: "before" }, { ...task, id: "after", key: "after", title: "Later task", brief: "Later brief", blockedBy: ["work"], report: undefined }],
    reports: [report], history: [] }
}
async function setup(value = mission()) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: "en-US" }), errors: string[] = [], mutations: string[] = [], requests: string[] = []
  page.setDefaultTimeout(7000)
  page.on("pageerror", error => { errors.push(error.message); console.error("Fixture page error", error.message) })
  let current = value
  await page.addInitScript("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text}}})")
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname
    requests.push(`${route.request().method()} ${pathname}`)
    if (route.request().method() !== "GET") mutations.push(route.request().url())
    if (/\/session\/(actor|native-parent)$/.test(pathname)) return route.fulfill({ json: { data: nativeSession(pathname.split("/").at(-1)!) } })
    return route.fulfill({ json: route.request().url().includes("/missions")
      ? { available: true, projectID: "project", missions: [current], generatedAt: 1, activity: { generatedAt: 1, missions: [{ missionId: "mission", actors: [{ sessionId: "actor", state: "running" }] }] } }
      : new URL(route.request().url()).pathname.endsWith("/shell") ? { location: { directory: "/fixture" }, data: [] } : {} })
  })
  await page.goto(url, { timeout: 30000 })
  await checklistTask(page).waitFor()
  return { page, errors, mutations, requests, replace: (next: MissionMap) => { current = next } }
}
const checklistTask = (page: Page, key = "work") => page.locator(`.mission-checklist li[data-task-key="${key}"] > button.mission-checklist-task`)
const show = (page: Page, id = "task") => page.evaluate(id => (window as any).taskReader.show(id), id)
const article = (page: Page, label: string) => page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: label, exact: true }) })
const disclosure = (page: Page, label: string) => page.locator(".mission-task-reader > details").filter({ has: page.locator("summary").filter({ hasText: new RegExp(`^${label}$`) }) })
async function expand(page: Page, label: string) {
  const details = disclosure(page, label)
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").click()
}
async function tails(surface: Locator, proof: string) {
  const input = surface.getByRole("spinbutton")
  await input.waitFor()
  await input.fill((await input.getAttribute("max"))!)
  await surface.page().waitForFunction(proof => document.querySelector(".mission-reader")?.textContent?.includes(proof), proof)
  assert((await surface.innerText()).includes(proof))
  assert((await surface.locator(".markdown-body, pre").first().textContent())!.length <= 9001)
}

test("checklist rows and compact dependency rows hold one line; the toggled reader owns all detail and measured graph", async () => {
  const f = await setup()
  try {
    const task = checklistTask(f.page)
    assert.equal(await f.page.locator(".mission-checklist li[data-task-key]").count(), 2, "withdrawn and replaced tasks leave the checklist")
    assert.equal(await f.page.locator('.mission-checklist li[data-task-key="before"]').count(), 0)
    assert.equal(await f.page.locator('.mission-checklist li[data-task-key="work"]').locator("summary, details, .mission-execution, .mission-task-dependencies, p").count(), 0)
    assert(!(await task.innerText()).includes("BRIEF"))
    assert.equal(await task.getAttribute("aria-pressed"), "false")
    await task.click()
    await f.page.locator(".mission-reader").getByRole("heading", { name: "Work title", exact: true }).waitFor()
    assert.equal(await task.getAttribute("aria-pressed"), "true")
    const dependencies = f.page.locator(".mission-disclosure-trigger", { hasText: "Show dependencies" })
    assert.equal(await dependencies.getAttribute("aria-expanded"), "false", "the dependency view starts collapsed")
    await dependencies.click()
    const row = f.page.locator('.mission-route-task[data-task-key="work"]')
    await row.waitFor()
    assert.equal(await row.locator("summary, details, .mission-execution, .mission-task-dependencies, p").count(), 0)
    assert.equal(await row.locator(".mission-list-feedback").count(), 0, "no empty second-line feedback beneath compact tasks")
    assert(!(await row.innerText()).includes("BRIEF"))
    assert.equal(await f.page.locator('.mission-graph path[data-from="before"][data-to="work"]').count(), 1)
    assert.equal(await f.page.locator('.mission-graph path[data-from="work"][data-to="after"]').count(), 1)
    const reader = f.page.locator(".mission-reader")
    assert.equal(await disclosure(f.page, "Task brief").evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.equal(await disclosure(f.page, "Technical details").evaluate(element => (element as HTMLDetailsElement).open), false)
    assert.deepEqual(await reader.getByRole("heading", { level: 3 }).allTextContents(), ["Summary", "Recommended next moves", "Evidence"])
    assert(!(await reader.innerText()).includes("requested-agent"), "requested execution is secondary to the result")
    await expand(f.page, "Technical details")
    assert((await reader.innerText()).includes("implementer"))
    assert((await reader.innerText()).includes("requested-agent"))
    assert(!(await reader.innerText()).includes("mutable-session-agent"), "mutable settings are not native invocation evidence")
    assert((await reader.innerText()).includes("Call return not recorded"))
    assert((await reader.innerText()).includes("Coordinator business readout; no notification is sent."))
    assert.equal(await reader.locator("[data-notification]").count(), 0)
    await expand(f.page, "Task brief")
    for (const [label, proof] of [["Task brief", "BRIEF_TAIL"], ["Summary", "SUMMARY_TAIL"], ["Evidence", "EVIDENCE_TAIL"],
      ["Recommended next moves", "NEXT_TAIL"], ["Structured report", "ARTIFACT_TAIL"]]) await tails(article(f.page, label), proof)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("dependencies, dependents and replacements navigate reader identity without touching execution or composer", async () => {
  const f = await setup()
  try {
    await f.page.locator("#draft").fill("Preserved draft")
    await f.page.locator("#transcript").evaluate(e => { e.scrollTop = 100 })
    await show(f.page)
    await expand(f.page, "Task brief")
    await expand(f.page, "Technical details")
    await article(f.page, "Task brief").getByRole("spinbutton").fill("2")
    await f.page.getByRole("button", { name: "Depends on Earlier task", exact: true }).click()
    await f.page.locator(".mission-reader").getByRole("heading", { name: "Earlier task", exact: true }).waitFor()
    assert((await f.page.locator(".mission-reader").innerText()).includes("Retired from the plan; native work is still outstanding."))
    assert.equal(await f.page.getByRole("button", { name: "Back to chat", exact: true }).evaluate(e => e === document.activeElement), true)
    await f.page.getByRole("button", { name: "Replaced by Work title", exact: true }).click()
    assert.equal(await article(f.page, "Task brief").getByRole("spinbutton").inputValue(), "1")
    await f.page.getByRole("button", { name: "Blocks Later task", exact: true }).click()
    await f.page.locator(".mission-reader").getByRole("heading", { name: "Later task", exact: true }).waitFor()
    assert.equal(await f.page.locator("#draft").inputValue(), "Preserved draft")
    assert.equal(await f.page.locator("#transcript").evaluate(e => e.scrollTop), 100)
    assert.equal((await f.page.evaluate(() => (window as any).taskReader.snapshot())).active, "coordinator")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("current task result does not promote a late return, but retains its native notification evidence in technical detail", async () => {
  const current = mission(), late: MissionReport = { ...current.reports[0], id: "late", createdAt: 3, late: true,
    delivery: "native-return", notificationStatus: "pending", summary: "Latest result" }
  current.tasks[1].lateReports = [late]
  const f = await setup(current)
  try {
    await show(f.page)
    await article(f.page, "Summary").locator(".markdown-body").waitFor()
    assert.match(await article(f.page, "Summary").innerText(), /SUMMARY/)
    assert(!(await article(f.page, "Summary").innerText()).includes("Latest result"), "late history must not replace the authoritative current result")
    const history = f.page.getByRole("region", { name: "Previous and late results", exact: true }).locator("details").filter({ has: f.page.locator("summary").filter({ hasText: "Latest result" }) })
    assert.equal(await history.evaluate(element => (element as HTMLDetailsElement).open), false, "late evidence starts as a historical disclosure")
    await history.locator(":scope > summary").click()
    await history.locator(":scope > details > summary").click()
    await expand(f.page, "Technical details")
    const text = await f.page.locator(".mission-reader").innerText()
    assert(text.includes("Latest result"), "late native-return report remains readable as historical evidence, not the current result")
    assert(text.includes("Report uses native-parent return route; consumption unconfirmed."))
    assert(text.includes("Coordinator notification pending (not admitted); no coordinator send requested."))
    assert(text.includes("Reported after task retirement or Mission Stop"))
    assert(text.includes("Call outcomes do not prove session termination or task completion."))
    assert(text.includes("Call return not recorded"))
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("reader task navigation fences delayed copy feedback across ABA identities and restores checklist focus on close", async () => {
  const f = await setup()
  try {
    const eye = checklistTask(f.page)
    await eye.click()
    await expand(f.page, "Task brief")
    await f.page.evaluate(() => { (navigator.clipboard as any).writeText = () => new Promise(resolve => { (window as any).releaseCopy = resolve }) })
    await article(f.page, "Task brief").getByRole("button", { name: "Copy", exact: true }).click()
    await f.page.getByRole("button", { name: "Depends on Earlier task", exact: true }).click()
    await f.page.getByRole("button", { name: "Replaced by Work title", exact: true }).click()
    await f.page.evaluate(() => (window as any).releaseCopy())
    assert(!(await article(f.page, "Task brief").innerText()).includes("Copied"))
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).press("Escape")
    await f.page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.equal(await eye.evaluate(e => e === document.activeElement), true)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("task reader session link uses authorized catalog navigation and never writes mission state", async () => {
  const f = await setup()
  try {
    await show(f.page)
    await f.page.locator(".mission-reader").getByRole("button", { name: "Open Native actor", exact: true }).click()
    await f.page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.equal((await f.page.evaluate(() => (window as any).taskReader.snapshot())).active, "actor")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const actor of [undefined, "coordinator", "unowned-worker"] as const)
test(`task reader never falls back to the coordinator for ${actor ?? "missing"} task identity`, async () => {
  const value = mission(); value.tasks[1].actorSessionId = actor
  const f = await setup(value)
  try {
    await show(f.page)
    const reader = f.page.locator(".mission-reader")
    assert.equal(await reader.locator(".mission-inline-session").count(), 0)
    await expand(f.page, "Technical details")
    assert.equal(await reader.getByRole("button", { name: /^Open / }).count(), 0)
    assert.equal((await f.page.evaluate(() => (window as any).taskReader.snapshot())).active, "coordinator")
    assert.deepEqual(f.requests.filter(request => request.includes("/session/")), [])
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const transition of ["target-aba", "directory-aba", "conversation-aba", "reconnect", "remount", "membership"] as const)
test(`late native session preparation cannot navigate or publish cache after ${transition}`, async () => {
  const f = await setup()
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await f.page.route("**/instance/api/session/actor", async route => { reached(); await held; await route.fulfill({ json: { data: nativeSession("actor") } }) })
    await f.page.evaluate(() => (window as any).taskReader.removeActor())
    await show(f.page)
    await f.page.locator(".mission-reader").getByRole("button", { name: "Open Native actor", exact: true }).click()
    await started
    if (transition === "target-aba") { await show(f.page, "before"); await show(f.page) }
    if (transition === "directory-aba") {
      await f.page.evaluate(() => (window as any).taskReader.directory("/other"))
      await f.page.evaluate(() => (window as any).taskReader.directory("/fixture"))
    }
    if (transition === "conversation-aba") {
      await f.page.evaluate(() => (window as any).taskReader.conversation("other"))
      await f.page.evaluate(() => (window as any).taskReader.conversation("coordinator"))
    }
    if (transition === "reconnect") await f.page.evaluate(() => (window as any).taskReader.reconnect())
    if (transition === "remount") {
      await f.page.evaluate(() => (window as any).taskReader.mount(false))
      await f.page.evaluate(() => (window as any).taskReader.mount(true))
    }
    if (transition === "membership") {
      const next = mission(); next.actors = next.actors.filter(actor => actor.sessionId !== "actor")
      f.replace(next); await f.page.evaluate(() => (window as any).taskReader.refresh())
    }
    const response = f.page.waitForResponse(response => response.url().endsWith("/instance/api/session/actor"))
    release(); await response
    // Let the refresh promise and its continuation finish without a timer.
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal((await f.page.evaluate(() => (window as any).taskReader.snapshot())).active, "coordinator")
    assert.equal((await f.page.evaluate(() => (window as any).taskReader.snapshot())).actor, undefined)
    assert.equal(await f.page.locator(".mission-reader").count(), 1)
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { release(); await f.page.close() }
})

test("cold task session navigation hydrates only its native ID and parent chain, retaining the exact native location", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).taskReader.removeActor())
    await show(f.page)
    await f.page.locator(".mission-reader").getByRole("button", { name: "Open Native actor", exact: true }).click()
    await f.page.locator(".mission-reader").waitFor({ state: "detached" })
    const snapshot = await f.page.evaluate(() => (window as any).taskReader.snapshot())
    assert.equal(snapshot.active, "actor")
    assert.equal(snapshot.actor.parentId, "native-parent")
    assert.deepEqual(snapshot.actor.location, { directory: "/fixture/native-worktree" })
    assert.equal(snapshot.parent.id, "native-parent")
    assert.deepEqual(f.requests.filter(request => request.includes("/session")), [
      "GET /workspaces/task-reader/instance/api/session/actor", "GET /workspaces/task-reader/instance/api/session/native-parent",
    ])
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const deleted of [false, true]) test(`cold task session ${deleted ? "deleted during read" : "missing natively"} keeps reader and selection unchanged`, async () => {
  const f = await setup()
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await f.page.route("**/instance/api/session/actor", async route => {
      reached(); await held
      await route.fulfill(deleted ? { json: { data: nativeSession("actor") } } : { status: 404, json: { name: "NotFoundError", data: { message: "Missing session" } } })
    })
    await f.page.evaluate(() => (window as any).taskReader.removeActor()); await show(f.page)
    await f.page.locator(".mission-reader").getByRole("button", { name: "Open Native actor", exact: true }).click(); await started
    if (deleted) await f.page.evaluate(() => (window as any).taskReader.deleteActor())
    const response = f.page.waitForResponse(response => response.url().endsWith("/instance/api/session/actor"))
    release(); await response
    if (!deleted) await f.page.getByRole("alert").waitFor()
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const snapshot = await f.page.evaluate(() => (window as any).taskReader.snapshot())
    assert.equal(snapshot.active, "coordinator"); assert.equal(snapshot.actor, undefined)
    assert.equal(snapshot.view.reader.itemId, "task")
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.errors, [])
  } finally { release(); await f.page.close() }
})
