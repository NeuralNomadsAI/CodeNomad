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

for (const mode of ["local", "nonlocal", "sidecars", "missing", "failure"]) {
  for (const surface of ["blank", "settings"]) {
    test(`${surface}: host-only controls require affirmative local metadata (${mode})`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" })
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      try {
        await page.goto(`${url}?mode=${mode}&surface=${surface}`)
        await page.locator("html[data-meta-settled=true]").waitFor()
        const local = mode === "local"
        // A non-local client opens SideCars only when the host allows it over direct HTTPS.
        const sidecars = local || mode === "sidecars"
        if (surface === "blank") {
          assert.equal(await page.getByRole("button", { name: "Fixture SideCar", exact: false }).count(), Number(sidecars))
          assert.equal(await page.getByRole("button", { name: "New SideCar", exact: true }).count(), 1)
        } else if (surface === "settings") {
          assert.equal(await page.getByRole("button", { name: "Connect CodeNomad Server", exact: true }).count(), Number(local))
          // Registration stays usable through paired and LAN connections.
          assert.equal(await page.getByRole("button", { name: "Add SideCar", exact: true }).count(), 1)
          assert.equal(await page.getByRole("button", { name: "Change password", exact: true }).count(), Number(local))
          // Only the host changes who may open SideCars.
          assert.equal(await page.getByRole("switch", { name: "Open SideCars over HTTPS", exact: true }).count(), Number(local))
          if (local) {
            await page.getByRole("button", { name: "Change password", exact: true }).click()
            assert.equal(await page.locator('input[type="password"]').count(), 2)
          } else {
            assert.equal(await page.locator('input[type="password"]').count(), 0)
          }
        }
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    })
  }
}

test("listening and Remote Control locks preserve only device-local SideCar administration", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" })
  try {
    for (const mode of ["local", "sidecars"]) {
      await page.goto(`${url}?mode=${mode}&surface=settings&locked=1`)
      await page.locator("html[data-meta-settled=true]").waitFor()
      await page.getByText("Disabled by administrator", { exact: true }).waitFor()
      const listening = page.getByRole("switch", { name: "Allow connections from other IPs", exact: true })
      await listening.waitFor()
      assert.equal(await listening.isChecked(), true)
      assert.equal(await listening.isDisabled(), true)
      assert.equal(await page.getByRole("switch", { name: "Open SideCars over HTTPS", exact: true }).count(), Number(mode === "local"))
      assert.equal(await page.getByRole("button", { name: "Change password", exact: true }).count(), Number(mode === "local"))
      for (const name of ["Start Remote Control", "Create new pairing link", "Create HTTPS pairing link"]) {
        assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name)
      }
      assert.equal(await page.getByRole("switch", { name: "Web previews", exact: true }).count(), 0)
      if (mode === "local") {
        const optIn = page.getByRole("switch", { name: "Open SideCars over HTTPS", exact: true })
        await optIn.click()
        await page.waitForFunction(() => (document.querySelector('[role="switch"][aria-label="Open SideCars over HTTPS"]') as HTMLInputElement).checked)
        assert.deepEqual(await page.evaluate(() => (window as unknown as { configWrites: unknown[] }).configWrites),
          [{ owner: "server", patch: { sidecarsOverDirectHttps: true } }])
      } else {
        assert.deepEqual(await page.evaluate(() => (window as unknown as { configWrites: unknown[] }).configWrites), [])
      }
    }
  } finally { await page.close() }
})

for (const mode of ["servers", "servers-readonly", "servers-refused"]) test(`the empty tab uses host server capabilities (${mode}) with the strict flag`, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" })
  try {
    for (const relay of [true, false]) {
      await page.goto(`${url}?mode=${mode}&surface=blank&scenario=saved&relay=${relay}`)
      await page.locator("html[data-meta-settled=true]").waitFor()
      await page.waitForFunction(() => (window as any).hostControlsConfig.isLoaded())
      assert.equal(await page.getByRole("button", { name: "Open a project on Desk", exact: true }).count(), Number(relay && mode !== "servers-refused"))
      assert.equal(await page.getByRole("textbox", { name: "Server address or link", exact: true }).count(), Number(relay && mode === "servers"))
      assert.equal(await page.getByRole("button", { name: /Fixture SideCar/ }).count(), 0)
    }
  } finally { await page.close() }
})
