import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page, type Route } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { panelMissions, missionContentFixture } from "./mission-content-fixture"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "mission-content-intents", routes: [{ path: "/mission-content-intents",
    html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-editor-lifetime.tsx\"></script></body></html>" }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

function mission(revision: number, objective: string, notes?: string): MissionMap {
  return { version: 1, id: "msn_intent", projectID: "project", projectCanonical: "/fixture", title: "Intent mission", objective, ...(notes === undefined ? {} : { notes }),
    template: "custom", coordinatorSessionId: "ses_fixture", status: "active", runState: "running", actors: [], tasks: [], reports: [], frontier: [], claims: [],
    history: [], historyTruncated: false, revision, createdAt: 1, updatedAt: revision } as MissionMap
}
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

/** The real Missions panel over `list()` (served with descriptors) and content read from `content()`. */
async function panel(options: { list: () => MissionMap; content: () => MissionMap; onContent?: (address: URL) => Promise<void> | void }) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 1000 } })
  const errors: string[] = [], writes: Array<Record<string, unknown>> = [], preferenceWrites: Array<Record<string, any>> = [], reads: URL[] = []
  let settings: Record<string, unknown> = {}
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request(), address = new URL(request.url()), path = address.pathname
    if (path.includes("/storage/config/ui")) {
      if (request.method() !== "GET") { const body = request.postDataJSON(), patch = body.patch ?? body; preferenceWrites.push(patch); settings = { ...settings, ...patch.settings } }
      return route.fulfill({ json: { settings } })
    }
    if (path.endsWith("/content")) {
      reads.push(address)
      await options.onContent?.(address)
      return route.fulfill({ json: missionContentFixture(request.url(), request.method(), [options.content()]) }).catch(() => undefined)
    }
    if (path.includes("/missions") && request.method() !== "GET") {
      const input = request.postDataJSON() as Record<string, unknown>
      writes.push(input)
      return route.fulfill({ json: { mission: { ...options.list(), objective: input.objective, notes: input.notes, revision: options.list().revision + 1 } } })
    }
    if (path.endsWith("/missions/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] } })
    if (path.endsWith("/missions")) return route.fulfill({ json: { available: true, version: 1, projectID: "project", missions: panelMissions([options.list()]),
      cleanups: [], generatedAt: 1, discardedEvents: 0, activity: { generatedAt: 1, missions: [] } } })
    if (path.endsWith("/subagent-depth")) return route.fulfill({ json: { location: { directory: "/fixture" }, capability: { minimum: 0 }, effectiveDepth: 1,
      project: { path: "/fixture/.opencode/opencode.jsonc", depth: null, expectation: "e" } } })
    return route.fulfill({ json: {} })
  })
  await events.route(page)
  await page.goto(url, { timeout: 60_000 })
  await page.evaluate(async () => {
    const instances = "/src/stores/instances.ts", view = "/src/stores/mission-view-state.ts"
    ;(await import(instances)).setActiveInstanceId("fixture")
    ;(await import(view)).updateMissionProjectView("/fixture", { selected: "msn_intent" })
  })
  await page.getByRole("button", { name: "Edit selected mission", exact: true }).waitFor()
  return { page, errors, writes, preferenceWrites, reads }
}
const refresh = (page: Page) => page.evaluate(async () => { const path = "/src/stores/missions.ts"; await (await import(path)).missionStore.refresh("fixture") })
const fields = (page: Page) => page.locator("form.mission-editor textarea")
const status = (page: Page) => page.locator("form.mission-editor").getByRole("status")
const briefButton = (page: Page) => page.locator("section.mission-detail").getByRole("button", { name: "Save as brief", exact: true })
const saveBrief = (page: Page) => page.locator(".mission-brief-save").getByRole("button", { name: "Save brief", exact: true })
const briefStatus = (page: Page) => page.locator(".mission-brief-save").getByRole("status")

test("an edit prefills only the fields of the map it opened: a warm older body never, a newer one only after Reopen", { timeout: 90_000 }, async () => {
  let listed = mission(1, "old-objective", "old-notes"), served = listed, hold: ReturnType<typeof gate> | undefined
  const f = await panel({ list: () => listed, content: () => served, onContent: async () => { await hold?.promise } })
  try {
    // Warm the cache at revision 1: Save as brief reads both fields whole, then its field closes.
    await briefButton(f.page).click()
    await f.page.getByLabel("Brief name", { exact: true }).fill("Warm")
    await f.page.waitForFunction(() => !(document.querySelector(".mission-brief-save button[type=button]") as HTMLButtonElement)?.disabled)
    await f.page.locator(".mission-brief-save").getByRole("button", { name: "Cancel saving the brief", exact: true }).click()
    // Revision 3 changes both fields; Edit opens on it while its reads are held.
    listed = served = mission(3, "new-objective", "new-notes")
    await refresh(f.page)
    hold = gate()
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await status(f.page).filter({ hasText: "Reading the mission map…" }).waitFor()
    assert.deepEqual(await fields(f.page).evaluateAll(nodes => nodes.map(node => [(node as HTMLTextAreaElement).value, (node as HTMLTextAreaElement).disabled])),
      [["", true], ["", true]], "the retained revision-1 bodies never prefill a revision-3 edit")
    hold.release(); hold = undefined
    await f.page.waitForFunction(() => !(document.querySelector("form.mission-editor textarea") as HTMLTextAreaElement)?.disabled)
    assert.deepEqual([await fields(f.page).nth(0).inputValue(), await fields(f.page).nth(1).inputValue()], ["new-objective", "new-notes"])
    await fields(f.page).nth(0).fill("User typed draft")
    await f.page.locator("form.mission-editor button[type=submit]").click()
    await f.page.locator("form.mission-editor").waitFor({ state: "detached" })
    assert.deepEqual(f.writes.map(write => [write.objective, write.notes, write.expectedRevision]), [["User typed draft", "new-notes", 3]],
      "untouched notes save as the opened map's, at its CAS revision")

    // The fields change after the edit opens: never prefilled; Reopen starts from the newest map.
    listed = served = mission(5, "fifth-objective", "fifth-notes")
    await refresh(f.page)
    served = mission(6, "sixth-objective", "sixth-notes")
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await status(f.page).filter({ hasText: "This mission changed since you opened it." }).waitFor()
    assert.deepEqual(await fields(f.page).evaluateAll(nodes => nodes.map(node => [(node as HTMLTextAreaElement).value, (node as HTMLTextAreaElement).disabled])),
      [["", true], ["", true]])
    assert.equal(await f.page.locator("form.mission-editor button[type=submit]").isDisabled(), true)
    listed = served
    await f.page.locator("form.mission-editor").getByRole("button", { name: "Reopen", exact: true }).click()
    await f.page.waitForFunction(() => (document.querySelector("form.mission-editor textarea") as HTMLTextAreaElement)?.value === "sixth-objective")
    assert.equal(await fields(f.page).nth(1).inputValue(), "sixth-notes")
    assert.equal(f.writes.length, 1, "nothing was saved from a changed field")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a Reopen in progress keeps the old form read-only, so no draft is lost to it; a failed or cancelled Reopen leaves the form usable", { timeout: 90_000 }, async () => {
  let listed = mission(3, "objective A", "notes A"), served = mission(4, "objective B", "notes B")
  let hold: ReturnType<typeof gate> | undefined, entered: ReturnType<typeof gate> | undefined, failList = false
  const f = await panel({ list: () => listed, content: () => served })
  // The list read Reopen waits for, held or failed on demand.
  await f.page.route(target => target.pathname === "/api/workspaces/fixture/missions", async route => {
    if (hold) { entered?.release(); await hold.promise }
    if (failList) return route.fulfill({ status: 503, json: { error: "Mission map unavailable" } })
    return route.fulfill({ json: { available: true, version: 1, projectID: "project", missions: panelMissions([listed]), cleanups: [], generatedAt: 1,
      discardedEvents: 0, activity: { generatedAt: 1, missions: [] } } }).catch(() => undefined)
  })
  const reopen = () => f.page.locator("form.mission-editor").getByRole("button", { name: "Reopen", exact: true })
  const invalidateBodies = () => f.page.evaluate(async () => { const path = "/src/stores/mission-content.ts"; (await import(path)).missionContent.invalidate("fixture") })
  try {
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await reopen().waitFor()
    // Reopen waits on its list read while the fields return to A, which the opened revision 3 named.
    hold = gate(); entered = gate()
    await reopen().click()
    await entered.promise
    listed = served = mission(5, "objective A", "notes A")
    await invalidateBodies()
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)))
    assert.deepEqual(await fields(f.page).evaluateAll(nodes => nodes.map(node => [(node as HTMLTextAreaElement).value, (node as HTMLTextAreaElement).disabled])),
      [["", true], ["", true]], "the matching fields do not reopen the old form while Reopen runs")
    await status(f.page).filter({ hasText: "Reading the mission map…" }).waitFor()
    await assert.rejects(fields(f.page).nth(0).fill("Draft typed while Reopen waits", { timeout: 300 }), "no draft can be typed into it")
    hold.release(); hold = undefined
    await f.page.waitForFunction(() => !(document.querySelector("form.mission-editor textarea") as HTMLTextAreaElement)?.disabled)
    assert.deepEqual([await fields(f.page).nth(0).inputValue(), await fields(f.page).nth(1).inputValue()], ["objective A", "notes A"])
    // The reopened edit's draft stays: nothing replaces it later.
    await fields(f.page).nth(0).fill("Draft typed after Reopen")
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
    assert.equal(await fields(f.page).nth(0).inputValue(), "Draft typed after Reopen")
    await f.page.locator("form.mission-editor button[type=submit]").click()
    await f.page.locator("form.mission-editor").waitFor({ state: "detached" })
    assert.deepEqual(f.writes.map(write => [write.objective, write.notes, write.expectedRevision]), [["Draft typed after Reopen", "notes A", 5]],
      "saved at the reopened map's CAS revision")

    // A Reopen whose list read fails says so and offers Reopen again; the next one succeeds.
    listed = mission(6, "objective C", "notes C")
    await refresh(f.page)
    served = mission(7, "objective D", "notes D")
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await reopen().waitFor()
    failList = true
    await reopen().click()
    await status(f.page).filter({ hasText: "This content could not be read." }).waitFor()
    failList = false; listed = served
    await reopen().click()
    await f.page.waitForFunction(() => (document.querySelector("form.mission-editor textarea") as HTMLTextAreaElement)?.value === "objective D")
    await f.page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()

    // A Reopen cancelled while it waits reopens nothing (fields not cached yet, so they are read and differ).
    listed = mission(8, "objective E", "notes E")
    await refresh(f.page)
    served = mission(9, "objective F", "notes F")
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await reopen().waitFor()
    hold = gate(); entered = gate()
    await reopen().click()
    await entered.promise
    await f.page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
    hold.release(); hold = undefined
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
    assert.equal(await f.page.locator("form.mission-editor").count(), 0)
    assert.equal(f.writes.length, 1)
    assert.deepEqual(f.errors, [])
  } finally { hold?.release(); await f.page.close() }
})

test("Save as brief stays ready through unrelated revisions and reads each input once", { timeout: 90_000 }, async () => {
  let listed = mission(1, "Objective stays", "Notes stay")
  const f = await panel({ list: () => listed, content: () => listed, onContent: () => { listed = { ...listed, revision: listed.revision + 1, updatedAt: listed.revision + 1 } } })
  try {
    await briefButton(f.page).click()
    await f.page.getByLabel("Brief name", { exact: true }).fill("Busy brief")
    await f.page.waitForFunction(() => !(document.querySelector(".mission-brief-save button[type=button]") as HTMLButtonElement)?.disabled)
    for (let cycle = 0; cycle < 12; cycle++) {
      listed = { ...listed, revision: listed.revision + 1, updatedAt: listed.revision + 1 }
      await refresh(f.page)
      assert.equal(await saveBrief(f.page).isDisabled(), false, `cycle ${cycle}`)
    }
    assert.equal(f.reads.length, 2, "objective and notes, each read once")
    const saved = f.page.waitForResponse(response => response.url().includes("/storage/config/ui") && response.request().method() !== "GET")
    await saveBrief(f.page).click(); await saved
    const record = f.preferenceWrites.find(patch => patch.settings?.missionModels)?.settings.missionModels[0]
    assert.deepEqual([record.objective, record.notes], ["Objective stays", "Notes stay"])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a map without notes names no notes body: Save as brief and the edit form read only its objective and take empty notes", { timeout: 90_000 }, async () => {
  const listed = mission(2, "only-objective")
  const f = await panel({ list: () => listed, content: () => listed })
  try {
    await briefButton(f.page).click()
    await f.page.getByLabel("Brief name", { exact: true }).fill("No notes")
    await f.page.waitForFunction(() => !(document.querySelector(".mission-brief-save button[type=button]") as HTMLButtonElement)?.disabled)
    const saved = f.page.waitForResponse(response => response.url().includes("/storage/config/ui") && response.request().method() !== "GET")
    await saveBrief(f.page).click(); await saved
    const record = f.preferenceWrites.find(patch => patch.settings?.missionModels)?.settings.missionModels[0]
    assert.deepEqual([record.objective, record.notes], ["only-objective", ""])
    await f.page.getByRole("button", { name: "Edit selected mission", exact: true }).click()
    await f.page.waitForFunction(() => !(document.querySelector("form.mission-editor textarea") as HTMLTextAreaElement)?.disabled)
    assert.deepEqual([await fields(f.page).nth(0).inputValue(), await fields(f.page).nth(1).inputValue()], ["only-objective", ""])
    assert.deepEqual([...new Set(f.reads.map(address => address.searchParams.get("field")))], ["objective"], "the absent notes are never read")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("Save as brief saves both inputs of one snapshot, an absent field included, and gives up after bounded restarts", { timeout: 90_000 }, async () => {
  // The opened map has no notes; its objective changes before it is read, and the notes appear with it.
  let listed = mission(1, "old-objective"), served = mission(3, "new-objective", "new-notes")
  const f = await panel({ list: () => listed, content: () => served, onContent: () => { listed = served } })
  try {
    await briefButton(f.page).click()
    await f.page.getByLabel("Brief name", { exact: true }).fill("Coherent brief")
    await f.page.waitForFunction(() => !(document.querySelector(".mission-brief-save button[type=button]") as HTMLButtonElement)?.disabled)
    const saved = f.page.waitForResponse(response => response.url().includes("/storage/config/ui") && response.request().method() !== "GET")
    await saveBrief(f.page).click(); await saved
    const record = f.preferenceWrites.find(patch => patch.settings?.missionModels)?.settings.missionModels[0]
    assert.deepEqual([record.objective, record.notes], ["new-objective", "new-notes"], "never new-objective with the old map's absent notes")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
  // An objective edited before every read, of the map and of the body, starts again a bounded number of times, then waits for Retry.
  let moving = true, revision = 1, changing = mission(revision, "objective 1", "notes")
  const edit = () => { if (moving) { revision++; changing = mission(revision, `objective ${revision}`, "notes") } return changing }
  const g = await panel({ list: edit, content: () => changing, onContent: address => { if (address.searchParams.get("field") === "objective") edit() } })
  try {
    await briefButton(g.page).click()
    await g.page.getByLabel("Brief name", { exact: true }).fill("Moving brief")
    await briefStatus(g.page).filter({ hasText: "This mission changed since you opened it." }).waitFor()
    assert.equal(await saveBrief(g.page).isDisabled(), true)
    const settled = g.reads.length
    await g.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)))
    assert.ok(settled <= 10 && g.reads.length === settled, `${settled} reads, then none`)
    // Retry starts again from the current map; the objective no longer changes, so the brief is ready.
    moving = false
    await refresh(g.page)
    await briefStatus(g.page).getByRole("button", { name: "Try again", exact: true }).click()
    await g.page.waitForFunction(() => !(document.querySelector(".mission-brief-save button[type=button]") as HTMLButtonElement)?.disabled)
    const saved = g.page.waitForResponse(response => response.url().includes("/storage/config/ui") && response.request().method() !== "GET")
    await saveBrief(g.page).click(); await saved
    const record = g.preferenceWrites.find(patch => patch.settings?.missionModels)?.settings.missionModels[0]
    assert.deepEqual([record.objective, record.notes], [changing.objective, "notes"])
    assert.deepEqual(g.errors, [])
  } finally { await g.page.close() }
})
