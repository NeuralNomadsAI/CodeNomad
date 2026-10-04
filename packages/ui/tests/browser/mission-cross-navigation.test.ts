import assert from "node:assert/strict"
import { before, after, test } from "node:test"
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
import type {} from "./fixtures/mission-cross-navigation"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-cross-navigation", configureServer(s) { s.middlewares.use("/mission-cross-navigation", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-cross-navigation", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-cross-navigation.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-cross-navigation`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
function mission(id: string): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: `Objective ${id}`, template: "custom", notes: "Private objective reader",
    coordinatorSessionId: `ses_${id}`, status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision: 1,
    createdAt: 1, updatedAt: 1, history: [], historyTruncated: false }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function setup(missing = false) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1600, height: 950 } })
  const errors: string[] = [], networkErrors: string[] = [], requests: string[] = [], hold = gate(), reached = gate(), complete = gate()
  let defer = false
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => networkErrors.push(`${request.url()} ${request.failure()?.errorText}`))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname; requests.push(`${route.request().method()} ${pathname}`)
    const location = { directory: "/fixture" }
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [mission("A"), mission("B")], generatedAt: 1, discardedEvents: 0 } })
    if (pathname.endsWith("/instance/api/session/ses_A")) {
      if (defer) { reached.release(); await hold.promise }
      await route.fulfill(missing ? { status: 404, json: { name: "NotFoundError", data: { message: "Missing session" } } }
        : { json: { data: { id: "ses_A", projectID: "project", title: "ses_A", slug: "ses_A", version: "1", location, time: { created: 1, updated: 1 } } } })
      if (defer) complete.release(); return
    }
    if (pathname.endsWith("/worktrees")) return route.fulfill({ json: { isGitRepo: true, worktrees: [{ slug: "root", directory: "/fixture", kind: "root" }] } })
    if (pathname === "/api/previews") return route.fulfill({ json: { token: "private-preview", sessionId: "ses_initial", targetUrl: "https://example.invalid/", proxyUrl: "/private-preview-frame", createdAt: "2026-10-03" } })
    if (pathname.endsWith("/command")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: { location, data: [{ id: "build", name: "build", mode: "primary" }, { id: "plan", name: "plan", mode: "primary" }] } })
    if (pathname.endsWith("/provider") || pathname.endsWith("/model")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/model/default")) return route.fulfill({ json: { location, data: null } })
    if (pathname.includes("/message")) return route.fulfill({ json: { data: [], cursor: {} } })
    if (pathname.includes("/form")) return route.fulfill({ json: { data: [] } })
    if (pathname.includes("/session")) return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ json: {} })
  })
  await page.route("**/private-preview-frame", route => route.fulfill({ contentType: "text/html", body: "<p>Private browser preview</p>" }))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Objective A", exact: true }).waitFor()
    await page.evaluate(() => window.missionCrossNavigation.coldCatalogue())
  } catch (error) {
    if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `setup-failure-${Date.now()}.json`), JSON.stringify({ error: String(error), errors, networkErrors, requests }, null, 2))
    hold.release(); await page.close(); throw error
  }
  return { page, errors, networkErrors, requests, hold, reached, complete, defer: () => { defer = true } }
}
const row = (page: Page, id: string) => page.locator(".mission-control-index > .mission-list-item").filter({ has: page.getByRole("button", { name: `Objective ${id}`, exact: true }) })
async function ordinarySession(page: Page, name: string) { await page.locator(".session-sidebar").getByText(`Conversation ${name}`, { exact: true }).click() }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) }
for (const origin of ["actor", "reader"] as const) for (const change of ["session", "session-aba", "preview", "preview-aba"] as const) {
  test(`shell deferred ${origin} respects external ${change}`, async () => {
    const { page, errors, networkErrors, requests, hold, reached, complete, defer } = await setup()
    try {
      defer()
      if (origin === "reader") await page.evaluate(() => window.missionCrossNavigation.clearActive())
      await clickMissionAction(row(page, "A"), origin === "actor" ? "Open coordinator" : "Read in chat area")
      await reached.promise
      if (change.startsWith("session")) {
        await ordinarySession(page, "B")
        if (change.endsWith("aba")) await ordinarySession(page, "initial")
      } else {
        if (origin === "reader") await ordinarySession(page, "initial")
        await page.getByRole("button", { name: "Open web preview", exact: true }).click()
        if (change.endsWith("aba")) await page.getByRole("button", { name: "Back to chat", exact: true }).click()
      }
      const before = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
      await page.evaluate(() => window.missionCrossNavigation.created())
      hold.release(); await complete.promise; await settle(page)
      const after = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
      if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) {
        await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `${origin}-${change}.json`), JSON.stringify({ before, after, errors, networkErrors, requests }, null, 2))
        await page.screenshot({ path: path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `${origin}-${change}.png`) })
      }
      assert.deepEqual(after, before, "ordinary session/preview navigation wins without late shared-state writes")
      assert.equal(await page.getByRole("tab", { name: "Missions", exact: true }).getAttribute("aria-selected"), "true")
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
      assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    } finally { hold.release(); await page.close() }
  })
}
for (const origin of ["actor", "reader"] as const) test(`shell current ${origin} survives its own synchronous navigation writes`, async () => {
  const { page, errors, networkErrors, hold, reached, complete, defer } = await setup()
  try {
    defer()
    if (origin === "reader") await page.evaluate(() => window.missionCrossNavigation.clearActive())
    await clickMissionAction(row(page, "A"), origin === "actor" ? "Open coordinator" : "Read in chat area")
    await reached.promise
    hold.release(); await complete.promise
    await page.waitForFunction(origin => {
      const current = window.missionCrossNavigation.snapshot()
      return current.session === "ses_A" && current.mode === "chat" && (origin === "actor" || current.reader?.missionId === "A")
    }, origin)
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
  } finally { hold.release(); await page.close() }
})

for (const change of ["session", "preview"] as const) test(`shell stale missing actor cannot publish an error over external ${change}`, async () => {
  const { page, errors, networkErrors, hold, reached, complete, defer } = await setup(true)
  try {
    defer(); await clickMissionAction(row(page, "A"), "Open coordinator"); await reached.promise
    if (change === "session") await ordinarySession(page, "B")
    else await page.getByRole("button", { name: "Open web preview", exact: true }).click()
    const before = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
    hold.release(); await complete.promise; await settle(page)
    const after = await page.evaluate(() => ({ state: window.missionCrossNavigation.snapshot(), writes: window.missionCrossNavigation.history().length }))
    if (process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE) await writeFile(path.join(process.env.CODENOMAD_CROSS_NAVIGATION_EVIDENCE, `missing-${change}.json`), JSON.stringify({ before, after, errors, networkErrors }, null, 2))
    assert.deepEqual(after, before); assert.equal(await page.locator(".mission-control > [role=alert]").count(), 0)
    assert.deepEqual(errors, []); assert.deepEqual(networkErrors, [])
  } finally { hold.release(); await page.close() }
})
