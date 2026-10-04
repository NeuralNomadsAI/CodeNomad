import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import path from "node:path"
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
    plugins: [solid(), shutdown.plugin, { name: "mission-navigation", configureServer(s) { s.middlewares.use("/mission-navigation", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-navigation", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-navigation.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-navigation`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Reader details",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function setup(missing = false) {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = [], networkErrors: string[] = [], requests: string[] = []
  const held = gate(), reached = gate(), completed = gate()
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => networkErrors.push(`${request.url()} ${request.failure()?.errorText}`))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname
    requests.push(`${route.request().method()} ${pathname}`)
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission("A"), mission("B")], generatedAt: 1, discardedEvents: 0 } })
    if (pathname.endsWith("/instance/api/session/ses_A")) {
      reached.release(); await held.promise
      await route.fulfill(missing ? { status: 404, json: { name: "NotFoundError", data: { message: "Missing session" } } }
        : { json: { data: { id: "ses_A", projectID: "project", title: "ses_A", slug: "ses_A", version: "1", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
      completed.release(); return
    }
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }, { id: "plan", name: "plan", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.includes("/instance/")) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Objective A", exact: true }).waitFor()
  } catch (error) {
    if (process.env.CODENOMAD_NAVIGATION_EVIDENCE) await writeFile(path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE, `setup-failure-${Date.now()}.json`), JSON.stringify({ error: String(error), errors, networkErrors, requests }, null, 2))
    held.release(); await page.close(); throw error
  }
  return { page, held, reached, completed, errors, networkErrors, requests }
}
const row = (page: Page, id: string) => page.locator(".mission-control-index > .mission-list-item").filter({ has: page.getByRole("button", { name: `Objective ${id}`, exact: true }) })
async function read(page: Page, id: string) {
  await row(page, id).waitFor()
  await clickMissionAction(row(page, id), "Read in chat area")
}
async function actor(page: Page, id: string) {
  await row(page, id).waitFor()
  await clickMissionAction(row(page, id), "Open coordinator")
}
async function settled(page: Page) {
  // Let the fulfilled HTTP response traverse the real Promise client and Solid
  // effects; this is not a mock replacement of navigation/selection logic.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
type Change = "reader" | "actor" | "selection" | "instance" | "instance-aba" | "directory-aba" | "project-aba" | "inactive-aba" | "remount" | "editor"
for (const origin of ["actor", "reader"] as const) for (const change of ["reader", "actor", "selection", "instance", "instance-aba", "directory-aba", "project-aba", "inactive-aba", "remount", "editor"] as const) {
  test(`deferred ${origin} A respects newer ${change}`, async () => {
    const state = await setup(), { page, held, reached, completed, errors, networkErrors, requests } = state
    try {
      if (origin === "reader") await page.evaluate(() => window.missionNavigation.clearActive())
      await (origin === "actor" ? actor(page, "A") : read(page, "A"))
      await reached.promise
      if (change.startsWith("instance")) {
        await page.evaluate(() => window.missionNavigation.instance("replacement"))
        if (change.endsWith("aba")) await page.evaluate(() => window.missionNavigation.instance("fixture"))
      } else if (change === "directory-aba") {
        await page.evaluate(() => window.missionNavigation.directory("/other")); await page.evaluate(() => window.missionNavigation.directory("/fixture"))
      } else if (change === "project-aba") {
        await page.evaluate(() => window.missionNavigation.project("other-project")); await page.evaluate(() => window.missionNavigation.project("project"))
      } else if (change === "inactive-aba") {
        await page.evaluate(() => window.missionNavigation.activate(false)); await page.evaluate(() => window.missionNavigation.activate(true))
      } else if (change === "remount") {
        await page.evaluate(() => window.missionNavigation.mount(false)); await page.evaluate(() => window.missionNavigation.mount(true))
      }
      if (change === "selection") await page.getByRole("button", { name: "Objective B", exact: true }).click()
      else if (change === "actor") await actor(page, "B")
      else if (change === "editor") { await page.getByRole("button", { name: "Create mission", exact: true }).click(); await page.getByLabel("Objective", { exact: true }).fill("New editor intent") }
      else await read(page, "B")
      const before = await page.evaluate(() => window.missionNavigation.snapshot())
      await page.evaluate(() => window.missionNavigation.created("ses_A"))
      held.release(); await completed.promise; await settled(page)
      const after = await page.evaluate(() => window.missionNavigation.snapshot())
      if (process.env.CODENOMAD_NAVIGATION_EVIDENCE) {
        await writeFile(path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE, `${origin}-${change}.json`), JSON.stringify({ before, after, errors, networkErrors, requests }, null, 2))
        await page.screenshot({ path: path.join(process.env.CODENOMAD_NAVIGATION_EVIDENCE, `${origin}-${change}.png`) })
      }
      assert.deepEqual(after, before, "stale navigation must not activate, clear/install readers or reveal")
      if (change === "editor") assert.equal(await page.getByLabel("Objective", { exact: true }).inputValue(), "New editor intent")
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
      assert.ok(requests.every(request => request.startsWith("GET ")), "navigation is read-only")
    } finally { held.release(); await page.close() }
  })
}

test("current reader without active session opens coordinator then installs its own reader", async () => {
  const { page, held, reached, completed, errors, networkErrors } = await setup()
  try {
    await page.evaluate(() => window.missionNavigation.clearActive())
    await read(page, "A"); await reached.promise
    held.release(); await completed.promise
    await page.waitForFunction(() => window.missionNavigation.snapshot().view.reader?.missionId === "A")
    const after = await page.evaluate(() => window.missionNavigation.snapshot())
    assert.equal(after.selectedSession, "ses_A"); assert.deepEqual(after.view.reader, { missionId: "A", kind: "overview" }); assert.equal(after.reveals, 2)
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
  } finally { held.release(); await page.close() }
})

test("missing coordinator does not install its reader after failed opening", async () => {
  const { page, held, reached, completed, errors } = await setup(true)
  try {
    await page.evaluate(() => window.missionNavigation.clearActive())
    await read(page, "A"); await reached.promise
    held.release(); await completed.promise
    await page.getByRole("alert").waitFor()
    const after = await page.evaluate(() => window.missionNavigation.snapshot())
    assert.equal(after.selectedSession, null); assert.equal(after.view.reader, undefined); assert.equal(after.reveals, 0)
    assert.deepEqual(errors, [])
  } finally { held.release(); await page.close() }
})

test("stale missing-coordinator error cannot overwrite a newer reader", async () => {
  const { page, held, reached, completed, errors } = await setup(true)
  try {
    await actor(page, "A"); await reached.promise; await read(page, "B")
    const before = await page.evaluate(() => window.missionNavigation.snapshot())
    held.release(); await completed.promise; await settled(page)
    assert.deepEqual(await page.evaluate(() => window.missionNavigation.snapshot()), before)
    assert.equal(await page.getByRole("alert").count(), 0); assert.deepEqual(errors, [])
  } finally { held.release(); await page.close() }
})
