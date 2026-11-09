import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "host-only-controls", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script>window.__CODENOMAD_WINDOW_CONTEXT__="local";window.__CODENOMAD_RUNTIME_HOST__="electron";window.electronAPI={}</script><script type="module" src="/tests/browser/fixtures/host-only-controls.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const mode of ["local", "nonlocal", "missing", "failure"]) {
  for (const surface of ["home", "settings", "picker"]) {
    test(`${surface}: host-only controls require affirmative local metadata (${mode})`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" })
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      try {
        await page.goto(`${url}?mode=${mode}&surface=${surface}`)
        await page.locator("html[data-meta-settled=true]").waitFor()
        const local = mode === "local"
        if (surface === "home") {
          assert.equal(await page.getByRole("button", { name: "Open SideCar", exact: true }).count(), Number(local))
          assert.equal(await page.getByRole("button", { name: "Connect CodeNomad Server", exact: true }).count(), Number(local))
        } else if (surface === "settings") {
          assert.equal(await page.getByRole("button", { name: "Connect CodeNomad Server", exact: true }).count(), Number(local))
          // Registration stays usable through paired and LAN connections.
          assert.equal(await page.getByRole("button", { name: "Add SideCar", exact: true }).count(), 1)
          assert.equal(await page.getByRole("button", { name: "Change password", exact: true }).count(), Number(local))
          if (local) {
            await page.getByRole("button", { name: "Change password", exact: true }).click()
            assert.equal(await page.locator('input[type="password"]').count(), 2)
          } else {
            assert.equal(await page.locator('input[type="password"]').count(), 0)
          }
        } else {
          assert.equal(await page.getByRole("dialog").count(), Number(local))
          if (local) await page.getByRole("button", { name: /Fixture SideCar/ }).waitFor()
        }
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    })
  }
}
