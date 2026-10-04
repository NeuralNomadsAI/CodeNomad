import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-editor-lifetime", configureServer(s) { s.middlewares.use("/editor-lifetime", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/editor-lifetime", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/editor-lifetime`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

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
  await page.getByRole("button", { name: "Objective two Active", exact: true }).click()
  if (change === "selection-aba") {
    await page.getByRole("button", { name: "Objective one Active", exact: true }).click()
    await page.getByRole("button", { name: "Objective two Active", exact: true }).click()
  }
  if (change === "new-editor") {
    if (await page.locator("form").count()) await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("Newer editor draft")
  }
}

for (const method of ["POST", "PATCH"] as const) for (const phase of ["mutation", "refresh"] as const) {
  for (const change of ["selection", "selection-aba", "unmount", "inactive", "inactive-aba", "instance", "instance-aba", "directory", "directory-aba", "project", "project-aba", "new-editor"] as const) {
    test(`${method} ${phase} completion respects ${change} origin and newer view intent`, async () => {
      const { page, errors } = await setup(), hold = gate(), reached = gate()
      let list = [mission("one"), mission("two")], completed = false, reads = 0
      const requests: Array<{ method: string; input: Record<string, unknown> }> = []
      try {
        await page.route("**/api/workspaces/*/missions**", async route => {
          const request = route.request()
          if (request.method() === "GET") {
            const version = ++reads
            if (completed && phase === "refresh" && new URL(request.url()).pathname.includes("/fixture/")) { reached.release(); await hold.promise }
            return route.fulfill({ json: { available: true, version: 1, projectID: "project", missions: list, cleanups: [], generatedAt: version, discardedEvents: 0 } })
          }
          requests.push({ method: request.method(), input: request.postDataJSON() as Record<string, unknown> })
          if (phase === "mutation") { reached.release(); await hold.promise }
          const saved = method === "POST" ? { ...mission("saved"), objective: "Saved result" } : { ...mission("one"), objective: "Saved result", revision: 2 }
          list = method === "POST" ? [...list, saved] : list.map(item => item.id === saved.id ? saved : item)
          completed = true
          return route.fulfill({ json: { mission: saved } })
        })
        await page.goto(url)
        await page.getByRole("button", { name: "Objective one Active", exact: true }).click()
        await page.getByRole("button", { name: method === "POST" ? "Create mission" : "Edit mission", exact: true }).first().click()
        await page.getByLabel("Objective", { exact: true }).fill("Original draft")
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await reached.promise
        if (phase === "refresh") await page.locator("form").waitFor({ state: "detached" })
        await transition(page, change)
        const response = page.waitForResponse(r => r.request().method() === (phase === "mutation" ? method : "GET") && r.url().includes("/fixture/missions"))
        hold.release(); await response
        // Read-only native invalidation makes the durable result visible even
        // when a disposed editor no longer owns an onSaved callback.
        if (change === "inactive") await page.evaluate(() => window.missionEditorLifetime.activate(true))
        await page.evaluate(() => window.missionEditorLifetime.invalidate())
        await page.getByRole("button", { name: "Saved result Active", exact: true }).waitFor()
        assert.match(await page.locator(".mission-control-index-item-active").innerText(), /Objective two/)
        if (change === "new-editor") {
          assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "Newer editor draft")
          assert.equal(await page.getByRole("alert").count(), 0)
        }
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
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: list, generatedAt: 1, discardedEvents: 0 } })
      writes++
      const saved = { ...mission(method === "POST" ? "saved" : "one"), objective: "Saved result", revision: method === "POST" ? 1 : 2 }
      list = method === "POST" ? [...list, saved] : list.map(item => item.id === saved.id ? saved : item)
      return route.fulfill({ json: { mission: saved } })
    })
    await page.goto(url)
    await page.getByRole("button", { name: "Objective two Active", exact: true }).click()
    await page.getByRole("button", { name: method === "POST" ? "Create mission" : "Edit mission", exact: true }).first().click()
    await page.getByLabel("Objective", { exact: true }).fill("Current")
    // Browsing before Save is not a late gesture: Save captures its own origin.
    await page.getByRole("button", { name: "Objective one Active", exact: true }).click()
    await page.getByRole("button", { name: "Objective two Active", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), false)
    const before = (await page.evaluate(() => window.missionEditorLifetime.selectedHistory())).length
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.locator(".mission-control-index-item-active", { hasText: "Saved result" }).waitFor()
    assert.equal(await page.locator("form").count(), 0); assert.equal(writes, 1)
    assert.equal((await page.evaluate(() => window.missionEditorLifetime.selectedHistory())).slice(before).filter(id => id === (method === "POST" ? "saved" : "one")).length, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("creation-uncertain retains original request/draft across close, remount and read-only refresh without resubmission", async () => {
  const { page, errors } = await setup(), attempts: Array<Record<string, unknown>> = []
  let list = [mission("one")], reads = 0
  try {
    await page.route("**/api/workspaces/fixture/missions**", route => {
      if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { available: true, projectID: "project", missions: list, generatedAt: reads, discardedEvents: 0 } }) }
      attempts.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ status: 409, json: { code: "creation-uncertain", error: "Mission creation settlement is unknown; deletion remains blocked" } })
    })
    await page.goto(url)
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    await page.getByLabel("Objective", { exact: true }).fill("Uncertain create")
    await page.getByLabel("Notes", { exact: true }).fill("Original notes")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "native creation result is unconfirmed" }).waitFor()
    assert.ok(!(await page.getByRole("alert").innerText()).includes("This mission changed"))
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    const original = await page.evaluate(() => window.missionEditorLifetime.held())
    assert.equal(original!.requestId, attempts[0].requestId)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "Uncertain create")
    assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), "Original notes")
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    // Even a map observed later is not a terminal receipt for the held creation.
    list = [...list, { ...mission("late"), objective: "Late durable map" }]
    await page.locator("form").getByRole("button", { name: "Refresh mission map", exact: true }).click()
    await page.getByRole("button", { name: "Late durable map Active", exact: true }).waitFor()
    await page.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    assert.equal(attempts.length, 1)
    assert.deepEqual(await page.evaluate(() => window.missionEditorLifetime.held()), original)
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    assert.match(await page.getByRole("alert").innerText(), /Refresh only reads state/)
    assert.match(await page.getByRole("alert").innerText(), /restart recovery are not yet qualified/)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await page.locator("form").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const method of ["POST", "PATCH"] as const) test(`late ${method} rejection cannot overwrite or close a newer editor`, async () => {
  const { page, errors } = await setup(), hold = gate(), reached = gate(), requests: Array<Record<string, unknown>> = []
  try {
    await page.route("**/api/workspaces/fixture/missions**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available: true, projectID: "project", missions: [mission("one"), mission("two")], generatedAt: 1, discardedEvents: 0 } })
      requests.push(route.request().postDataJSON() as Record<string, unknown>)
      reached.release(); await hold.promise
      return route.fulfill({ status: 409, json: { code: method === "POST" ? "creation-uncertain" : "revision-conflict", error: "private source credential" } })
    })
    await page.goto(url)
    await page.getByRole("button", { name: method === "POST" ? "Create mission" : "Edit mission", exact: true }).first().click()
    await page.getByLabel("Objective", { exact: true }).fill("Original rejected draft")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await reached.promise
    await transition(page, "new-editor")
    const rejected = page.waitForResponse(response => response.request().method() === method)
    hold.release(); await rejected
    await page.waitForFunction(() => Boolean(window.missionEditorLifetime.held()) || document.querySelector('form textarea')?.textContent !== "Original rejected draft")
    assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "Newer editor draft")
    assert.equal(await page.getByRole("alert").count(), 0)
    if (method === "POST") {
      assert.equal((await page.evaluate(() => window.missionEditorLifetime.held()))!.requestId, requests[0].requestId)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Create mission", exact: true }).click()
      assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "Original rejected draft")
      assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true)
    }
    assert.equal(requests.length, 1); assert.deepEqual(errors, [])
  } finally { hold.release(); await page.close() }
})
