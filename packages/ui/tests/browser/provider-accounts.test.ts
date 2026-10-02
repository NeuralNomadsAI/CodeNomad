import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "accounts-fixture", configureServer(s) {
      for (const [route, fixture] of [["/fixture", "provider-accounts"], ["/design", "provider-accounts-preview"]]) {
        s.middlewares.use(route, async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml(route, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${fixture}.tsx"></script></body></html>`))
        })
      }
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("native account dropdown activates by identity and preserves failed rename drafts", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    const select = page.getByRole("combobox", { name: "Active account" })
    await select.waitFor()
    assert.equal(await page.locator(".provider-accounts summary").count(), 0)
    assert.equal(await select.inputValue(), "credential:one")
    assert.equal(await select.locator('option[value="env:PROVIDER_KEY"]').evaluate(option => (option as HTMLOptionElement).disabled), true)
    await select.selectOption("credential:two")
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".provider-accounts select")?.value === "credential:two")
    assert.equal(await page.locator('[data-account-id="credential:one"]').count(), 0)
    await select.selectOption("credential:one")
    const first = page.locator('[data-account-id="credential:one"]')
    await first.getByRole("button", { name: "Rename account", exact: true }).click()
    await first.getByLabel("Account label").fill("New name")
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await first.getByLabel("Account label").inputValue(), "New name")
    await page.evaluate(() => (window as any).fixture.fail())
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await first.getByLabel("Account label").inputValue(), "New name")
    assert.equal((await page.evaluate(() => (window as any).fixture.writes)).length, 3)
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".provider-accounts select")?.selectedOptions[0].textContent === "New name")
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await first.getByRole("button", { name: "Remove account", exact: true }).click()
    await first.waitFor({ state: "detached" })
    assert.equal(await select.inputValue(), "credential:two")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [
      { action: "activate", credentialID: "two" }, { action: "activate", credentialID: "one" },
      { action: "rename", credentialID: "one", label: "New name" }, { action: "rename", credentialID: "one", label: "New name" },
      { action: "remove", credentialID: "one" },
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("provider manager keeps per-account drafts across dropdown and external switches", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?parent`)
    const select = page.getByRole("combobox", { name: "Active account" })
    await select.waitFor()
    await page.getByRole("button", { name: "Add account", exact: true }).click()
    await page.locator(".providers-connect-panel").getByRole("button", { name: "Close", exact: true }).click()
    const first = page.locator('[data-account-id="credential:one"]'), second = page.locator('[data-account-id="credential:two"]')
    await first.getByRole("button", { name: "Rename account", exact: true }).click()
    await first.getByLabel("Account label").fill("Uncommitted first")
    await select.selectOption("credential:two")
    await second.getByRole("button", { name: "Rename account", exact: true }).click()
    await second.getByLabel("Account label").fill("Uncommitted second")
    await page.evaluate(() => (window as any).fixture.switchExternally())
    await first.getByLabel("Account label").waitFor()
    assert.equal(await first.getByLabel("Account label").inputValue(), "Uncommitted first")
    await page.evaluate(() => (window as any).fixture.switchExternally())
    await second.getByLabel("Account label").waitFor()
    assert.equal(await second.getByLabel("Account label").inputValue(), "Uncommitted second")
    await select.selectOption("credential:one")
    await first.getByLabel("Account label").fill("Saved label")
    await page.evaluate(() => (window as any).fixture.deferParent())
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.parentPending())
    await first.getByLabel("Account label").fill("Newer draft")
    await page.evaluate(() => (window as any).fixture.releaseParent())
    await page.waitForFunction(() => !document.querySelector(".providers-loading-row"))
    assert.equal(await first.getByLabel("Account label").inputValue(), "Newer draft")
    assert.equal(await first.getByRole("button", { name: "Save", exact: true }).isEnabled(), true)
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("dropdown design simulates opt-in rotation and hides the option for one account", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const design = url.replace("/fixture", "/design")
  const card = page.locator(".providers-card").filter({ has: page.getByRole("heading", { name: "OpenAI", exact: true }) })
  const select = card.getByRole("combobox", { name: "Compte actif" })
  try {
    await page.goto(design)
    await select.waitFor()
    assert.equal(await select.inputValue(), "credential:personal")
    assert.equal(await select.locator("option").count(), 3)
    await page.mouse.move(0, 0)
    await select.evaluate(el => (el as HTMLElement).blur())
    assert.equal(await card.locator(".provider-accounts").evaluate(el => getComputedStyle(el).borderTopWidth), "1px")
    assert.equal(await card.locator(".provider-account-actions").evaluate(el => {
      for (let parent: Element | null = el; parent; parent = parent.parentElement) {
        if (Number(getComputedStyle(parent).opacity) < 1) return false
      }
      return true
    }), true)
    for (const width of [1280, 640, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const positions = await card.evaluate(el => {
        const name = el.querySelector("h4")!.getBoundingClientRect()
        const models = el.querySelector(".provider-model-card-actions")!.getBoundingClientRect()
        const select = el.querySelector("select")!.getBoundingClientRect()
        const actions = el.querySelector(".provider-account-actions")!.getBoundingClientRect()
        return { headerAligned: Math.abs((name.top + name.bottom) / 2 - (models.top + models.bottom) / 2) < 2,
          actionsAligned: Math.abs((select.top + select.bottom) / 2 - (actions.top + actions.bottom) / 2) < 2,
          separated: select.top > models.bottom, fits: el.scrollWidth <= el.clientWidth }
      })
      assert.deepEqual(positions, { headerAligned: true, actionsAligned: true, separated: true, fits: true })
    }
    await page.getByRole("button", { name: "Simuler 100 %" }).click()
    assert.equal(await page.evaluate(() => (window as any).accountsPreview.used().personal), 100)
    assert.equal(await select.inputValue(), "credential:personal")
    await page.goto(`${design}?auto`)
    await page.getByRole("checkbox", { name: "Sélection automatique du compte" }).waitFor()
    for (const id of ["work", "spare", "spare"]) {
      await page.getByRole("button", { name: "Simuler 100 %" }).click()
      await page.waitForFunction(expected => (window as any).accountsPreview.rows()[0].id === expected, id)
      await page.waitForFunction(expected => document.querySelector<HTMLSelectElement>(".providers-card .provider-accounts select")?.value === `credential:${expected}`, id)
    }
    await page.goto(`${design}?single`)
    await select.waitFor()
    assert.equal(await select.locator("option").count(), 1)
    assert.equal(await page.getByRole("checkbox", { name: "Sélection automatique du compte" }).count(), 0)
    await page.setViewportSize({ width: 390, height: 800 })
    assert.equal(await page.locator(".providers-accounts-list").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
