import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
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
  if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
    await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, "plugins-initial.png"), fullPage: true })
  }
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
  const noticeId = await page.locator(".plugin-controls-notice").getAttribute("id")
  assert.ok(noticeId)
  const projectDescription = await row.locator('[data-scope="project"] input').getAttribute("aria-describedby")
  assert.ok(projectDescription?.split(" ").includes(noticeId))
  assert.equal(await page.evaluate((ids) => ids!.split(" ").every(id => Boolean(document.getElementById(id))), projectDescription), true)
  assert.ok(!(await row.locator('[data-scope="global"] input').getAttribute("aria-describedby"))?.split(" ").includes(noticeId))

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

test("plugin rows retain focus through passive refresh and guarded pending mutations", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
  await page.goto(url)
  await page.evaluate(() => (window as any).fixture.show())
  const input = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="global"] input')
  await input.waitFor()
  await input.focus()
  const original = await input.elementHandle()
  await page.evaluate(() => (window as any).fixture.eventBurst())
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)

  await page.evaluate(() => (window as any).fixture.holdMutation())
  await input.press("Space")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
  assert.equal(await input.isChecked(), true, "pending state retains the authoritative value")
  await input.press("Space")
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length), 1)
  assert.equal(await input.isChecked(), true, "blocked repeat activation must not visually toggle")
  await input.click({ force: true })
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length), 1)
  assert.equal(await input.isChecked(), true, "blocked pointer activation must not visually toggle")
  await page.evaluate(() => (window as any).fixture.releaseMutation())
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "false")
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)
  assert.equal(await input.isChecked(), false)
  await input.press("Tab")
  assert.equal(await page.locator('[data-plugin-id="acme.reviewer"] [data-scope="project"] input').evaluate((node) => node === document.activeElement), true)
  await input.focus()
  await page.evaluate(() => { (window as any).fixture.holdMutation(); (window as any).fixture.failMutation() })
  await input.press("Space")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
  await page.evaluate(() => (window as any).fixture.releaseMutation())
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "false")
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)
  assert.equal(await input.isChecked(), false, "failed mutation retains the authoritative value")
  await page.close()
})

test("narrow keyboard and touch layouts expose complete plugin names, sources and errors", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 1200 }, hasTouch: true })
  await page.goto(url)
  const details = await page.evaluate(() => {
    const fixture = (window as any).fixture
    fixture.setNarrow()
    const details = fixture.setLongDetails()
    fixture.show()
    return details
  })
  const row = page.locator(`[data-plugin-id="${details.id}"]`)
  await row.waitFor()
  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((locale) => (window as any).fixture.setLocale(locale), direction === "rtl" ? "he" : "fr")
    await page.locator(".plugin-control-scope-label").filter({ hasText: direction === "rtl" ? "פרויקט" : "Projet" }).waitFor()
    await page.evaluate((dir) => { document.documentElement.dir = dir }, direction)
    await row.locator(".plugin-control-name").tap()
    await row.locator("input").first().focus()
    assert.ok((await row.locator(".plugin-control-sub").textContent())?.includes(details.source))
    assert.ok((await page.locator('[data-plugin-id="broken.plugin"] .plugin-control-sub').textContent())?.includes(details.error))
    const clipped = await page.locator(".plugin-control-name, .plugin-control-sub, .plugin-control-sub > span:last-child, .plugin-controls-footer > div").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map((node) => node.textContent))
    assert.deepEqual(clipped, [], `full text remains readable in ${direction}`)
    assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
    if (direction === "ltr") assert.deepEqual(await page.locator(".plugin-control-scope-label").allTextContents(), ["Global", "Projet"])
    if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
      await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, `plugins-narrow-${direction}.png`), fullPage: true })
    }
  }
  await page.close()
})

for (const fail of [false, true]) {
  test(`disposed plugin surfaces suppress late mutation feedback, failure=${fail}`, async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
    await page.goto(url)
    await page.evaluate((fail) => {
      const fixture = (window as any).fixture
      fixture.show()
      fixture.holdMutation()
      if (fail) fixture.failMutation()
    }, fail)
    const input = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="project"] input')
    await input.click()
    await page.waitForFunction(() => document.querySelector('input[aria-busy="true"]'))
    await page.evaluate(() => (window as any).fixture.unmount())
    assert.equal(await page.locator(".plugin-controls").count(), 0)
    await page.evaluate(() => (window as any).fixture.releaseMutation())
    // Flush the deferred response and its async presentation continuation.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.toastHistory()), [])
    await page.close()
  })
}
