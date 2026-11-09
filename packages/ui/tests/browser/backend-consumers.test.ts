import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

for (const mode of ["control", "reader"]) for (const delivery of ["immediate", "held"]) test(`real composers retain exact local history and isolate backends; Missions ${mode} uses physical directories; history ${delivery}`, { timeout: 60000 }, async () => {
  const fixture = await borrowFixture({ name: "backend-consumers", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-consumers.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = [], schedules: string[] = [], recurrences: string[] = [], remoteHistory: string[] = []
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
    if (request.pathname === "/api/backends/lab/api/workspaces/mission/missions/scheduled") {
      schedules.push(request.searchParams.get("directory")!)
      return route.fulfill({ json: { version: 1, projectID: "p", schedules: [] } })
    }
    if (request.pathname === "/api/backends/lab/api/workspaces/mission/missions/recurrence") {
      recurrences.push(request.pathname)
      return route.fulfill({ json: { version: 1, projectID: "p", schedules: [], actions: [] } })
    }
    return route.fulfill({ status: 503, json: { error: "Inventory unavailable in this fixture" } })
  })
  try {
    const recurrence = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/lab/api/workspaces/mission/missions/recurrence")
    const schedule = mode === "control" ? page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/lab/api/workspaces/mission/missions/scheduled") : undefined
    await page.goto(`${fixture.url}?mode=${mode}`)
    const local = page.locator('[data-composer="local"] textarea'), remote = page.locator('[data-composer="remote"] textarea')
    const pressHistory = async (composer: typeof local) => {
      await composer.focus()
      await page.waitForFunction(selector => document.activeElement === document.querySelector(selector),
        composer === local ? '[data-composer="local"] textarea' : '[data-composer="remote"] textarea')
      await composer.press("ArrowUp")
    }
    await Promise.all([
      (async () => {
        await page.waitForFunction(() => {
          const state = (window as any).backendConsumers
          if (!state) return false
          state.readinessChecks++
          const [localHistory, remoteHistory] = state.histories()
          return localHistory[0] === "legacy local history" && remoteHistory[0] === "remote history"
        })
        await pressHistory(local)
        assert.equal(await local.inputValue(), "legacy local history", "the persisted Windows key must retain case, backslashes and trailing slash")
        await pressHistory(remote)
        assert.equal(await remote.inputValue(), "remote history", "the real remote composer must receive its history identity")
      })(),
      (async () => {
        if (delivery !== "held") return
        await page.waitForFunction(() => {
          const state = (window as any).backendConsumers
          return state?.readinessChecks > 0 && state.histories()[0][0] === "legacy local history"
        })
        await remoteRequested
        const blocked = await page.evaluate(() => {
          const state = (window as any).backendConsumers
          return { histories: state.histories(), keys: state.keys }
        })
        assert.deepEqual(blocked, { histories: [["legacy local history"], []], keys: [] })
        releaseRemote()
      })(),
    ])
    assert.deepEqual(await page.evaluate(() => (window as any).backendConsumers.keys), [
      { target: "local", focused: true, published: true },
      { target: "remote", focused: true, published: true },
    ])
    await recurrence
    await schedule
    const result = await page.evaluate(() => (window as any).backendConsumers)
    assert.deepEqual(result.reads.concat(remoteHistory.map(key => `lab~${key}`)).sort(), [result.folder, `lab~${result.folder}`].sort())
    assert.ok(remoteHistory.every(key => key === result.folder), "remote storage HTTP receives the exact physical folder key")
    if (mode === "control") assert.ok(schedules.length)
    assert.ok(schedules.every(directory => directory === "/repo"), JSON.stringify(schedules))
    assert.ok(recurrences.length)
    assert.ok(recurrences.every(path => path === "/api/backends/lab/api/workspaces/mission/missions/recurrence"))
    assert.deepEqual(errors, [])
  } finally { releaseRemote(); await browser.close() }
})
