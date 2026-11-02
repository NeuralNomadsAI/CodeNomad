import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page, type Request } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import type {} from "./fixtures/mission-editor-lifetime"
import { clickMissionAction, inlineMissionEntry, selectMission, selectedMissionTitle } from "./mission-actions"
import { missionContentFixture, panelMissions } from "./mission-content-fixture"

const EDIT = "Edit selected mission"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-editor-lifetime",
      routes: [
        { path: "/editor-lifetime", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-editor-lifetime.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Notes",
    coordinatorSessionId: "ses_fixture", status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function setup() {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  // Creation Options read the project's nesting depth; a valid snapshot keeps its own alerts out.
  await page.route("**/subagent-depth*", route => route.fulfill({ json: { location: { directory: "/fixture" }, capability: { minimum: 0 },
    effectiveDepth: 1, project: { path: "/fixture/.opencode/opencode.jsonc", depth: null, expectation: "e" } } }))
  return { page, errors }
}
type Transition = "selection" | "selection-aba" | "unmount" | "inactive" | "inactive-aba" | "instance" | "instance-aba" | "directory" | "directory-aba" | "project" | "project-aba" | "new-editor"
async function transition(page: Page, change: Transition) {
  if (change === "unmount") {
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
  } else if (change.startsWith("inactive")) {
    await page.evaluate(() => window.missionEditorLifetime.activate(false))
    if (change.endsWith("aba")) await page.evaluate(() => window.missionEditorLifetime.activate(true))
  } else if (change.startsWith("instance")) {
    await page.evaluate(() => window.missionEditorLifetime.instance("other"))
    if (change.endsWith("aba")) await page.evaluate(() => window.missionEditorLifetime.instance("fixture"))
  } else if (change.startsWith("directory")) {
    await page.evaluate(() => window.missionEditorLifetime.directory("/other"))
    if (change.endsWith("aba")) await page.evaluate(() => window.missionEditorLifetime.directory("/fixture"))
  } else if (change.startsWith("project")) {
    await page.evaluate(() => window.missionEditorLifetime.project("other-project"))
    if (change.endsWith("aba")) await page.evaluate(() => window.missionEditorLifetime.project("project"))
  }
  // The creation form replaces the list: leaving it is the newer view intent before browsing.
  if (await page.locator(".mission-control[data-creating]").count()) await page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
  if (change === "inactive" || change === "project") {
    // A hidden panel performs no new reads. A new project cannot browse the old
    // project's rows; an exact restored target can load independently of discovery.
    await page.evaluate(async () => {
      const { updateMissionProjectView } = await import("/src/stores/mission-view-state.ts")
      updateMissionProjectView("/fixture", { selected: "two" })
    })
    if (change === "project") await page.locator('section.mission-detail[aria-label="Objective two"]').waitFor()
    return
  }
  await selectMission(page, "Objective two")
  if (change === "selection-aba") {
    await selectMission(page, "Objective one")
    await selectMission(page, "Objective two")
  }
  if (change === "new-editor") {
    if (await page.locator("form.mission-editor").count()) await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor textarea").first().fill("Newer editor draft")
  }
}

for (const method of ["POST", "PATCH"] as const) for (const phase of ["mutation", "refresh"] as const) {
  for (const change of ["selection", "selection-aba", "unmount", "inactive", "inactive-aba", "instance", "instance-aba", "directory", "directory-aba", "project", "project-aba", "new-editor"] as const) {
    test(`${method} ${phase} completion respects ${change} origin and newer view intent`, async () => {
      const { page, errors } = await setup(), hold = gate(), reached = gate()
      let list = [mission("one"), mission("two")], completed = false, reads = 0
      const otherProject = list.map(value => ({ ...value, projectID: "other-project" }))
      let sourceProject = "project"
      let refreshRequest: Request | undefined
      const refreshSettled = gate()
      page.on("request", request => {
        if (phase === "refresh" && completed && !refreshRequest && request.url().endsWith("/missions/panel-page") && request.postDataJSON()?.source === "summaries") refreshRequest = request
      })
      const settleRefresh = (request: Request) => { if (request === refreshRequest) refreshSettled.release() }
      page.on("requestfinished", settleRefresh); page.on("requestfailed", settleRefresh)
      const requests: Array<{ method: string; input: Record<string, unknown> }> = []
      try {
        await page.route("**/api/workspaces/*/missions**", async route => {
          const request = route.request(), content = missionContentFixture(request.url(), request.method(), list)
          if (content) return route.fulfill({ json: content })
          if (request.method() === "GET") {
            const version = ++reads
            const query = new URL(request.url()).searchParams
            if (completed && phase === "refresh" && new URL(request.url()).pathname.includes("/fixture/") && query.get("panelSource") === "summaries") { reached.release(); await hold.promise }
            return route.fulfill({ json: { available: true, version: 1, projectID: sourceProject, missions: panelMissions(sourceProject === "project" ? list : otherProject), cleanups: [], generatedAt: version, discardedEvents: 0 } })
          }
          requests.push({ method: request.method(), input: request.postDataJSON() as Record<string, unknown> })
          if (phase === "mutation") { reached.release(); await hold.promise }
          const saved = method === "POST" ? { ...mission("saved"), objective: "Saved result" } : { ...mission("one"), objective: "Saved result", revision: 2 }
          list = method === "POST" ? [...list, saved] : list.map(item => item.id === saved.id ? saved : item)
          completed = true
          return route.fulfill({ json: { mission: saved } })
        })
        await page.goto(url)
        await selectMission(page, "Objective one")
        if (method === "POST") await page.getByRole("button", { name: "Create mission", exact: true }).click()
        else await clickMissionAction(page, EDIT)
        await page.locator("form.mission-editor textarea").first().fill("Original draft")
        await page.locator("form.mission-editor button[type=submit]").first().click()
        await reached.promise
        if (phase === "refresh") await page.locator("form.mission-editor").waitFor({ state: "detached" })
        if (change === "project") sourceProject = "other-project"
        await transition(page, change)
        // A request in flight settles through its own hold, never as a reopened draft.
        if (change === "unmount") assert.equal(await page.locator("form.mission-editor").count(), 0)
        const response = phase === "mutation" ? page.waitForResponse(r => r.request().method() === method && !r.url().endsWith("/panel-page") && r.url().includes("/fixture/missions")) : refreshSettled.promise
        hold.release(); await response
        // Read-only native invalidation makes the durable result visible even
        // when a disposed editor no longer owns an onSaved callback.
        if (change === "inactive") await page.evaluate(() => window.missionEditorLifetime.activate(true))
        await page.evaluate(() => window.missionEditorLifetime.invalidate())
        if (change === "new-editor") {
          assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "Newer editor draft")
          assert.equal(await page.getByRole("alert").count(), 0)
          assert.equal(await page.locator(".mission-picker-control").isVisible(), false, "the newer creation form replaces the list")
          await page.locator("form.mission-editor").getByRole("button", { name: "Cancel", exact: true }).click()
        }
        if (change !== "project") await (await inlineMissionEntry(page, "Saved result")).waitFor()
        else assert.equal(await page.getByText("Saved result", { exact: true }).count(), 0, "an old-project completion never appears in the new project's inventory")
        assert.match(await selectedMissionTitle(page).innerText(), /^Objective two$/)
        assert.equal(requests.length, 1); assert.equal(requests[0].method, method)
        assert.equal(requests[0].input.directory, undefined, "view fencing must not change the native default creation location")
        if (method === "PATCH") assert.equal(requests[0].input.expectedRevision, 1)
        assert.ok(requests[0].input.requestId)
        assert.deepEqual(errors, [])
      } finally { hold.release(); await page.close() }
    })
  }
}

for (const method of ["POST", "PATCH"] as const) test(`current legitimate ${method} completion selects its own saved map exactly once`, async () => {
  const { page, errors } = await setup()
  let list = [mission("one"), mission("two")], writes = 0
  try {
    await page.route("**/api/workspaces/fixture/missions**", route => {
      const content = missionContentFixture(route.request().url(), route.request().method(), list)
      if (content) return route.fulfill({ json: content })
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(list), generatedAt: 1, discardedEvents: 0 } })
      writes++
      const saved = { ...mission(method === "POST" ? "saved" : "one"), objective: "Saved result", revision: method === "POST" ? 1 : 2 }
      list = method === "POST" ? [...list, saved] : list.map(item => item.id === saved.id ? saved : item)
      return route.fulfill({ json: { mission: saved } })
    })
    await page.goto(url)
    await selectMission(page, "Objective two")
    if (method === "POST") await page.getByRole("button", { name: "Create mission", exact: true }).click()
    else await clickMissionAction(page, EDIT, "Objective one")
    await page.locator("form.mission-editor textarea").first().fill("Current")
    // Browsing before Save is not a late gesture: Save captures its own origin.
    // The creation form replaces the list, so only an edit can browse meanwhile.
    if (method === "PATCH") {
      await selectMission(page, "Objective one")
      await selectMission(page, "Objective two")
    } else assert.equal(await page.locator(".mission-picker-control").isVisible(), false, "the creation form replaces the list")
    assert.equal(await page.locator("form.mission-editor button[type=submit]").first().isDisabled(), false)
    const before = (await page.evaluate(() => window.missionEditorLifetime.selectedHistory())).length
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await selectedMissionTitle(page).filter({ hasText: /^Saved result$/ }).waitFor()
    assert.equal(await page.locator("form.mission-editor").count(), 0); assert.equal(writes, 1)
    assert.equal((await page.evaluate(() => window.missionEditorLifetime.selectedHistory())).slice(before).filter(id => id === (method === "POST" ? "saved" : "one")).length, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const method of ["POST", "PATCH"] as const) test(`an unsent ${method} draft survives a hidden view, a panel remount and an instance round trip`, async () => {
  const { page, errors } = await setup(), writes: Array<Record<string, unknown>> = []
  let list = [mission("one")]
  try {
    await page.route("**/api/workspaces/*/missions**", route => {
      const content = missionContentFixture(route.request().url(), route.request().method(), list)
      if (content) return route.fulfill({ json: content })
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(list), generatedAt: 1, discardedEvents: 0 } })
      writes.push(route.request().postDataJSON() as Record<string, unknown>)
      const saved = { ...mission(method === "POST" ? "saved" : "one"), objective: "Kept draft", revision: method === "POST" ? 1 : 2 }
      list = method === "POST" ? [...list, saved] : [saved]
      return route.fulfill({ json: { mission: saved } })
    })
    await page.goto(url)
    if (method === "POST") await page.getByRole("button", { name: "Create mission", exact: true }).click()
    else await clickMissionAction(page, EDIT, "Objective one")
    const form = page.locator("form.mission-editor"), submit = form.locator("button[type=submit]")
    await form.locator("textarea").first().fill("Kept draft")
    if (method === "POST") {
      await form.locator("summary").filter({ hasText: /^Options$/ }).click()
      await form.getByLabel("Playbook", { exact: true }).selectOption("debug")
      await form.getByLabel("Notes", { exact: true }).fill("Kept notes")
    }
    for (const change of ["inactive-aba", "unmount", "instance-aba"] as const) {
      if (change === "inactive-aba") {
        await page.evaluate(() => window.missionEditorLifetime.activate(false))
        await page.evaluate(() => window.missionEditorLifetime.activate(true))
      } else if (change === "unmount") {
        await page.evaluate(() => window.missionEditorLifetime.mount(false))
        await page.evaluate(() => window.missionEditorLifetime.mount(true))
      } else {
        await page.evaluate(() => window.missionEditorLifetime.instance("other"))
        assert.equal(await form.count(), 0, "another panel scope has no editor open")
        await page.evaluate(() => window.missionEditorLifetime.instance("fixture"))
      }
      assert.equal(await form.locator("textarea").first().inputValue(), "Kept draft", change)
      if (method === "POST") {
        assert.equal(await form.getByLabel("Playbook", { exact: true }).inputValue(), "debug", change)
        assert.equal(await form.getByLabel("Notes", { exact: true }).inputValue(), "Kept notes", change)
      }
      await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    }
    await submit.click()
    await form.waitFor({ state: "detached" })
    assert.equal(writes.length, 1)
    assert.equal(writes[0].objective, "Kept draft")
    if (method === "POST") { assert.equal(writes[0].template, "debug"); assert.equal(writes[0].notes, "Kept notes") }
    else assert.equal(writes[0].expectedRevision, 1)
    // A closed editor stays closed, and the next one starts blank.
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    assert.equal(await form.count(), 0)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await form.locator("textarea").first().fill("Discarded draft")
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    assert.equal(await form.count(), 0)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await form.locator("textarea").first().inputValue(), "")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("creation-uncertain retains original request/draft across close, remount and read-only refresh without resubmission", async () => {
  const { page, errors } = await setup(), attempts: Array<Record<string, unknown>> = []
  let list = [mission("one")], reads = 0
  try {
    await page.route("**/api/workspaces/fixture/missions**", route => {
      const content = missionContentFixture(route.request().url(), route.request().method(), list)
      if (content) return route.fulfill({ json: content })
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions(list), generatedAt: reads, discardedEvents: 0 } }) }
      attempts.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ status: 409, json: { code: "creation-uncertain", error: "Mission creation settlement is unknown; deletion remains blocked" } })
    })
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.locator("form.mission-editor textarea").first().fill("Uncertain create")
    await page.locator("form.mission-editor summary").filter({ hasText: /^Options$/ }).click()
    await page.getByLabel("Notes", { exact: true }).fill("Original notes")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    const uncertain = page.getByRole("alert").filter({ hasText: "native creation result is unconfirmed" })
    await uncertain.waitFor()
    assert.ok(!(await uncertain.innerText()).includes("This mission changed"))
    assert.equal(await page.locator("form.mission-editor button[type=submit]").first().isDisabled(), true)
    const original = await page.evaluate(() => window.missionEditorLifetime.held())
    assert.equal(original!.requestId, attempts[0].requestId)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "Uncertain create")
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "Uncertain create", "the held title is restored with its draft")
    assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), "Original notes")
    assert.equal(original!.title, "Uncertain create")
    assert.equal(await page.locator("form.mission-editor button[type=submit]").first().isDisabled(), true)
    // Even a map observed later is not a terminal receipt for the held creation.
    list = [...list, { ...mission("late"), objective: "Late durable map" }]
    // Discovery remains summary-only while the creation form hides the picker.
    await page.locator("form.mission-editor").getByRole("button", { name: "Refresh mission map", exact: true }).click()
    await page.waitForFunction(() => (window.missionEditorLifetime.state("fixture") as { summaries?: Array<{ id: string }> }).summaries?.some(value => value.id === "late"))
    assert.equal(await page.locator(".mission-picker-control").isVisible(), false)
    await page.locator("form.mission-editor").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.equal(attempts.length, 1)
    assert.deepEqual(await page.evaluate(() => window.missionEditorLifetime.held()), original)
    assert.equal(await page.locator("form.mission-editor button[type=submit]").first().isDisabled(), true)
    assert.match(await uncertain.innerText(), /Refresh only reads state/)
    assert.match(await uncertain.innerText(), /restart recovery are not yet qualified/)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await page.locator("form.mission-editor").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const method of ["POST", "PATCH"] as const) test(`late ${method} rejection cannot overwrite or close a newer editor`, async () => {
  const { page, errors } = await setup(), hold = gate(), reached = gate(), requests: Array<Record<string, unknown>> = []
  try {
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      const content = missionContentFixture(route.request().url(), route.request().method(), [mission("one"), mission("two")])
      if (content) return route.fulfill({ json: content })
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: panelMissions([mission("one"), mission("two")]), generatedAt: 1, discardedEvents: 0 } })
      requests.push(route.request().postDataJSON() as Record<string, unknown>)
      reached.release(); await hold.promise
      return route.fulfill({ status: 409, json: { code: method === "POST" ? "creation-uncertain" : "revision-conflict", error: "private source credential" } })
    })
    await page.goto(url)
    if (method === "POST") await page.getByRole("button", { name: "Create mission", exact: true }).click()
    else await clickMissionAction(page, EDIT, "Objective one")
    await page.locator("form.mission-editor textarea").first().fill("Original rejected draft")
    await page.locator("form.mission-editor button[type=submit]").first().click()
    await reached.promise
    await transition(page, "new-editor")
    const rejected = page.waitForResponse(response => response.request().method() === method)
    hold.release(); await rejected
    await page.waitForFunction(() => Boolean(window.missionEditorLifetime.held()) || document.querySelector('form.mission-editor textarea')?.textContent !== "Original rejected draft")
    assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "Newer editor draft")
    assert.equal(await page.getByRole("alert").count(), 0)
    if (method === "POST") {
      assert.equal((await page.evaluate(() => window.missionEditorLifetime.held()))!.requestId, requests[0].requestId)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      assert.equal(await page.locator("form.mission-editor textarea").first().inputValue(), "Original rejected draft")
      assert.equal(await page.locator("form.mission-editor button[type=submit]").first().isDisabled(), true)
    }
    assert.equal(requests.length, 1); assert.deepEqual(errors, [])
  } finally { hold.release(); await page.close() }
})
