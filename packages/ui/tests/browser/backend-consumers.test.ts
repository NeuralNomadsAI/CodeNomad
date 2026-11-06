import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

for (const mode of ["control", "reader"]) test(`real composers retain exact local history and isolate backends; Missions ${mode} uses physical directories`, async () => {
  const fixture = await borrowFixture({ name: "backend-consumers", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-consumers.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(`${fixture.url}?mode=${mode}`)
    await page.waitForFunction(() => (window as any).backendConsumers?.reads.length >= 1)
    const local = page.locator('[data-composer="local"] textarea'), remote = page.locator('[data-composer="remote"] textarea')
    await local.press("ArrowUp")
    assert.equal(await local.inputValue(), "legacy local history", "the persisted Windows key must retain case, backslashes and trailing slash")
    await remote.press("ArrowUp")
    assert.equal(await remote.inputValue(), "remote history", "the real remote composer must receive its history identity")
    await page.waitForFunction(mode => (window as any).backendConsumers.recurrences.length
      && (mode !== "control" || (window as any).backendConsumers.schedules.length), mode)
    const result = await page.evaluate(() => (window as any).backendConsumers)
    assert.deepEqual(result.reads.sort(), [result.folder, `lab~${result.folder}`].sort())
    assert.ok(result.schedules.every((directory: string) => directory === "/repo"), JSON.stringify(result.schedules))
    assert.ok(result.recurrences.every((id: string) => id === "lab~mission"))
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
