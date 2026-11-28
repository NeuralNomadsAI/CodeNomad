import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// The Mission surface changes its own requests, not either composer's history delivery.
for (const delivery of ["held", "immediate"]) test(`real composers retain exact local history and isolate backends; Missions use physical directories; history ${delivery}`, { timeout: 60000 }, async () => {
  const fixture = await borrowFixture({ name: "backend-consumers", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-consumers.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = [], programmed: string[] = [], remoteHistory: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  let releaseRemote!: () => void
  const remoteGate = new Promise<void>(resolve => { releaseRemote = resolve })
  let markRemoteRequested!: () => void
  const remoteRequested = new Promise<void>(resolve => { markRemoteRequested = resolve })
  if (delivery === "immediate") releaseRemote()
  await page.route("**/api/backends/lab/api/**", async route => {
    const request = new URL(route.request().url())
    if (request.pathname.startsWith("/api/backends/lab/api/storage/instances/")) {
      remoteHistory.push(decodeURIComponent(request.pathname.slice("/api/backends/lab/api/storage/instances/".length)))
      markRemoteRequested()
      await remoteGate
      return route.fulfill({ json: { messageHistory: ["remote history"], agentModelSelections: {} } })
    }
    if (request.pathname === "/api/backends/lab/api/workspaces/mission/missions/calendars") {
      programmed.push(request.searchParams.get("directory")!)
      return route.fulfill({ json: { calendars: [] } })
    }
    return route.fulfill({ status: 503, json: { error: "Inventory unavailable in this fixture" } })
  })
  try {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/lab/api/workspaces/mission/missions/calendars")
    await page.goto(fixture.url)
    const local = page.locator('[data-composer="local"] textarea'), remote = page.locator('[data-composer="remote"] textarea')
    await Promise.all([
      (async () => {
        await page.waitForFunction(() => {
          const state = (window as any).backendConsumers
          if (!state) return false
          const [localHistory, remoteHistory] = state.histories()
          return localHistory[0] === "legacy local history" && remoteHistory[0] === "remote history"
        })
        await local.press("ArrowUp")
        assert.equal(await local.inputValue(), "legacy local history", "the persisted Windows key must retain case, backslashes and trailing slash")
        await remote.press("ArrowUp")
        assert.equal(await remote.inputValue(), "remote history", "the real remote composer must receive its history identity")
      })(),
      (async () => {
        if (delivery !== "held") return
        await page.waitForFunction(() => {
          const state = (window as any).backendConsumers
          return state?.histories()[0][0] === "legacy local history"
        })
        await remoteRequested
        assert.deepEqual(await page.evaluate(() => (window as any).backendConsumers.histories()), [["legacy local history"], []])
        releaseRemote()
      })(),
    ])
    await read
    const result = await page.evaluate(() => (window as any).backendConsumers)
    assert.deepEqual(result.reads, [result.folder], "local storage receives the physical folder key")
    assert.deepEqual(remoteHistory, [result.folder], "remote storage HTTP receives the physical folder key")
    assert.ok(programmed.length)
    assert.ok(programmed.every(directory => directory === "/repo"), JSON.stringify(programmed))
    assert.deepEqual(errors, [])
  } finally { releaseRemote(); await browser.close() }
})
