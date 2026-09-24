import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [solid(), { name: "plugin-controls-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/plugin-controls.tsx"></script></body></html>'))
      })
    } }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test("V2 plugin controls load on demand and expose explicit Global and Project switches", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)

  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 0, "a hidden plugin section must not load")
  await page.evaluate(() => (window as any).fixture.show())
  await page.getByText("acme.reviewer", { exact: true }).waitFor()
  assert.equal(await page.locator(".plugin-control-row").count(), 3)
  assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').count(), 6)
  assert.deepEqual(await page.locator(".plugin-control-scope-label").allTextContents(), ["Global", "Project"])
  assert.equal(await page.locator(".plugin-controls-description").count(), 1)
  assert.equal(await page.locator(".plugin-controls-footer").count(), 1)
  assert.equal(await page.getByText("Global — Rule target: /daemon/opencode.jsonc", { exact: false }).count(), 1)
  assert.equal(await page.getByText("Project — Rule target: /repo/.opencode/opencode.jsonc", { exact: false }).count(), 1)
  assert.equal(await page.locator('[data-plugin-id="broken.plugin"]').getByText("Failed", { exact: false }).count(), 1)
  assert.equal(await page.locator('[data-plugin-id="sleeping.plugin"]').getByText("overrides", { exact: false }).count(), 1)
  assert.equal(await page.getByText("Runtime inventory", { exact: true }).count(), 0)
  assert.equal(await page.getByText("Configured entries", { exact: true }).count(), 0)
  assert.equal(await page.getByText("opencode.provider.demo", { exact: true }).count(), 0)
  assert.equal(await page.getByText("opencode.prompt.identity", { exact: true }).count(), 0)
  assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').first().isDisabled(), false)

  const inherited = page.locator('[data-plugin-id="broken.plugin"]')
  const inheritedGlobal = inherited.locator('[data-scope="global"] input[type="checkbox"]')
  const inheritedProject = inherited.locator('[data-scope="project"] input[type="checkbox"]')
  assert.equal(await inheritedGlobal.isChecked(), true)
  assert.equal(await inheritedProject.isChecked(), true)
  await inheritedProject.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "broken.plugin"
      && call.scope === "project" && call.enabled === false
  )))
  assert.equal(await inheritedGlobal.isChecked(), true, "a Project override must not change the Global switch")
  assert.equal(await inheritedProject.isChecked(), false)

  const sleeping = page.locator('[data-plugin-id="sleeping.plugin"]')
  const globalToggle = sleeping.locator('[data-scope="global"] input[type="checkbox"]')
  const projectToggle = sleeping.locator('[data-scope="project"] input[type="checkbox"]')
  assert.equal(await globalToggle.isChecked(), true)
  assert.equal(await projectToggle.isChecked(), false)
  await projectToggle.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "sleeping.plugin"
      && call.scope === "project" && call.enabled === true
  )))
  assert.equal(await projectToggle.isChecked(), true)

  const acmeGlobal = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="global"] input[type="checkbox"]')
  await acmeGlobal.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "acme.reviewer"
      && call.scope === "global" && call.enabled === false
  )))

  const switchGeometry = await page.evaluate(() => {
    const track = document.querySelector(".plugin-control-row .MuiSwitch-track")!
    const root = document.querySelector(".plugin-control-row .MuiSwitch-root") as HTMLElement | null
    const box = (root ?? track as HTMLElement).getBoundingClientRect()
    return { radius: getComputedStyle(track).borderRadius, width: Math.round(box.width), height: Math.round(box.height) }
  })
  assert.notEqual(switchGeometry.radius, "0px")
  assert.deepEqual([switchGeometry.width, switchGeometry.height], [40, 24])

  const readsBeforeSessionChange = await page.evaluate(() => (window as any).fixture.reads())
  await page.evaluate(() => (window as any).fixture.switchSession())
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.reads()),
    readsBeforeSessionChange,
    "another session in the same worktree must reuse the snapshot",
  )

  const readsBeforeActivation = await page.evaluate(() => (window as any).fixture.reads())
  await page.evaluate(() => (window as any).fixture.hide())
  await page.waitForFunction(() => !(window as any).fixture.isActive())
  await page.evaluate(() => (window as any).fixture.activateSleepingPlugin())
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.reads()),
    readsBeforeActivation,
    "events must not refresh a hidden plugin section",
  )
  await page.evaluate(() => (window as any).fixture.show())
  await page.waitForFunction((before) => (window as any).fixture.reads() > before, readsBeforeActivation)
  const burstReads = await page.evaluate(() => (window as any).fixture.eventBurst())
  assert.equal(burstReads, 2, "an in-flight event burst must coalesce into one trailing refresh")
  assert.deepEqual(errors, [])
  await page.close()
})

test("V2 plugin controls disable Project when it resolves to the Global document", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)

  await page.evaluate(() => (window as any).fixture.setTargets(["global"]))
  await page.evaluate(() => (window as any).fixture.show())
  await page.getByText("acme.reviewer", { exact: true }).waitFor()

  const row = page.locator('[data-plugin-id="acme.reviewer"]')
  assert.equal(await row.locator('[data-scope="global"] input[type="checkbox"]').isDisabled(), false)
  assert.equal(await row.locator('[data-scope="project"] input[type="checkbox"]').isDisabled(), true)
  assert.equal(await page.locator(".plugin-controls-notice").count(), 1)

  const mutationsBefore = await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length)
  await row.locator('[data-scope="project"] input[type="checkbox"]').click({ force: true })
  await page.waitForTimeout(200)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length),
    mutationsBefore,
    "a disabled Project switch must not mutate",
  )

  await page.evaluate(() => (window as any).fixture.setNarrow())
  await page.waitForTimeout(100)
  const narrowLane = await row.locator('[data-scope="global"]').boundingBox()
  assert.ok((narrowLane?.width ?? 48) <= 40, "narrow panels compact the switch lanes")
  assert.deepEqual(errors, [])
  await page.close()
})
