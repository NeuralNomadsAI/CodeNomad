import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { chromium, devices, _electron, type ElectronApplication, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { observeHeaderFixture } from "./header-fixture-diagnostics"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "header-windows-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("the real shell badge reopens the selected question with a same-session permission queued", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator("textarea.prompt-input").fill("Keep the composer draft")
    await page.evaluate(() => (window as any).fixture.askQuestion())
    const answer = page.locator('.interruption-dock input[type="text"]:visible')
    await answer.fill("Keep this question selected")
    await page.evaluate(() => (window as any).fixture.queuePermission())
    assert.equal(await page.locator(".interruption-position").innerText(), "2 / 2")
    assert.equal(await answer.inputValue(), "Keep this question selected")
    await page.getByRole("button", { name: "Collapse requests", exact: true }).click()
    assert.equal(await answer.count(), 0)

    // Exercise InstanceShell's production callback, not a fixture focusInterruption intent.
    await page.locator(".session-header-indicators .permission-center-trigger:visible").click()
    await answer.waitFor()
    assert.equal(await page.locator(".interruption-position").innerText(), "2 / 2")
    assert.equal(await page.locator(".interruption-dock .window-title").innerText(), "Your response")
    assert.equal(await answer.inputValue(), "Keep this question selected")
    assert.equal(await page.locator("textarea.prompt-input").inputValue(), "Keep the composer draft")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("native Electron zoom preserves CSS minimums across close/recreate, shared local siblings and isolated framed remote windows", { timeout: 90000 }, async () => {
  const sandbox = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "codenomad-window-zoom-"))
  let app: ElectronApplication | undefined
  try {
    const module = join(sandbox, "zoom.cjs")
    const root = fileURLToPath(new URL("../../../electron-app/electron/main/", import.meta.url)).replaceAll("\\", "/")
    await build({ stdin: { contents: `export * from "${root}window-state.ts"; export * from "${root}menu.ts";`, resolveDir: root },
      outfile: module, bundle: true, platform: "node", format: "cjs", external: ["electron"] })
    const env = { ...process.env, CODENOMAD_TEST_PROFILE: join(sandbox, "profile"), CODENOMAD_TEST_ZOOM_MODULE: module, CODENOMAD_TEST_ZOOM_URL: url }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON || createRequire(import.meta.url)("electron"),
      args: [fileURLToPath(new URL("fixtures/window-zoom-electron.cjs", import.meta.url))], env })
    const page = await app.firstWindow()
    page.on("pageerror", error => console.error("[zoom fixture]", error))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    for (const zoom of [0.8, 1, 1.25, 1.5]) {
      for (const index of [0, 1]) {
        await app.evaluate((_electron, { index, zoom }) => { const f = (globalThis as any).zoomFixture; f.zoom(index, zoom); f.fit(index) }, { index, zoom })
        const size = await app.evaluate((_electron, index) => (globalThis as any).zoomFixture.snapshot(index), index)
        assert.equal(size.minimum[0] - (size.outer[0] - size.content[0]), Math.ceil(390 * zoom), `content width at ${zoom} zoom, frame=${index}`)
        assert.ok(size.content[0] / size.zoom >= 390 && size.content[0] / size.zoom < 392)
      }
      await page.waitForFunction(() => window.innerWidth >= 390 && window.innerWidth < 392)
      await page.locator(".session-header-actions-menu").waitFor({ state: "visible" })
      assert.equal(await page.locator(".session-header-expanded-actions").isVisible(), false)
      assert.equal(await page.locator(".message-timeline-sidebar").isVisible(), false)
      if (process.env.CODENOMAD_HEADER_CAPTURE_DIR) {
        await mkdir(process.env.CODENOMAD_HEADER_CAPTURE_DIR, { recursive: true })
        const capture = await app.evaluate(() => (globalThis as any).zoomFixture.capture())
        await writeFile(join(process.env.CODENOMAD_HEADER_CAPTURE_DIR, `native-zoom-${zoom}.png`), Buffer.from(capture, "base64"))
      }
    }
    await app.evaluate(() => (globalThis as any).zoomFixture.menu(0, "Actual Size"))
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom, 1)
    await app.evaluate(() => (globalThis as any).zoomFixture.menu(0, "Zoom In"))
    const menuZoom = (await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom
    assert.ok(menuZoom > 1)
    await page.bringToFront()
    await app.evaluate(() => (globalThis as any).zoomFixture.input(0, "-"))
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom, 1)
    await app.evaluate(() => (globalThis as any).zoomFixture.zoom(0, 0.8))
    await app.evaluate(() => (globalThis as any).zoomFixture.fit(0))
    const saved = await app.evaluate(() => (globalThis as any).zoomFixture.save())
    assert.equal(saved.bounds.width, 312)
    await app.evaluate(() => (globalThis as any).zoomFixture.reload())
    await page.waitForFunction(() => Boolean((window as any).fixture) && window.innerWidth >= 390 && window.innerWidth < 392)
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).minimum[0], 312)
    const recreated = await app.evaluate(() => (globalThis as any).zoomFixture.recreate())
    assert.equal(recreated.beforeLoad.content[0], 312, "startup constraints must use saved 80% zoom before navigation")
    assert.equal(recreated.beforeLoad.minimum[0], 312)
    assert.equal(recreated.afterLoad.content[0], 312, "close/recreate must not expand saved content to the 100% baseline")
    assert.equal(recreated.afterLoad.zoom, 0.8)
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.save())).zoomFactor, 0.8)

    assert.deepEqual(await app.evaluate(() => (globalThis as any).zoomFixture.sibling()), { sharedSession: true, sameOrigin: true })
    assert.equal(await app.evaluate(() => (globalThis as any).zoomFixture.sharedAuth()), "shared-auth")
    // Confirm Chromium's real host-zoom propagation, not a mock of it.
    await app.evaluate(() => (globalThis as any).zoomFixture.rawZoom(0, 1.5))
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(2))).zoom, 1.5)
    for (const action of ["explicit", "menu", "keyboard", "wheel-request"] as const) {
      await app.evaluate(() => {
        const f = (globalThis as any).zoomFixture
        f.zoom(0, 0.8); f.fit(0); f.fit(2)
      })
      await app.evaluate(async (_electron, action) => {
        const f = (globalThis as any).zoomFixture
        if (action === "explicit") f.zoom(0, 1.25)
        else if (action === "menu") f.menu(0, "Zoom In")
        else if (action === "keyboard") await f.input(0, "=")
        else f.wheelRequest(0, "in")
      }, action)
      const sizes = await app.evaluate(() => [0, 2].map(index => (globalThis as any).zoomFixture.snapshot(index)))
      assert.equal(sizes[0].zoom, sizes[1].zoom, `${action} shares host zoom`)
      for (const size of sizes) {
        assert.equal(size.minimum[0] - (size.outer[0] - size.content[0]), Math.ceil(390 * size.zoom), `${action} reconciles both constraints`)
        assert.ok(size.content[0] / size.zoom >= 390 && size.content[1] / size.zoom >= 600, `${action} grows undersized siblings`)
      }
      const peerSaved = await app.evaluate(() => (globalThis as any).zoomFixture.save(2))
      assert.equal(peerSaved.zoomFactor, sizes[0].zoom, `${action} persists sibling zoom`)
      await app.evaluate(() => (globalThis as any).zoomFixture.reload(2))
      assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom, sizes[0].zoom, "sibling reload must not revert the initiator")
      assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.save(2))).zoomFactor, sizes[0].zoom)
      await app.evaluate(() => (globalThis as any).zoomFixture.reload(0))
      assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(2))).zoom, sizes[0].zoom, "initiator reload keeps shared desired zoom")
    }
    const localZoom = (await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom
    await app.evaluate(() => (globalThis as any).zoomFixture.reload(1))
    await app.evaluate(() => (globalThis as any).zoomFixture.zoom(1, 1.5))
    assert.equal((await app.evaluate(() => (globalThis as any).zoomFixture.snapshot(0))).zoom, localZoom, "same-origin remote partition remains independent")
    const peerRecreated = await app.evaluate(() => (globalThis as any).zoomFixture.recreate(2))
    assert.equal(peerRecreated.afterLoad.zoom, localZoom, "shared zoom survives closing/recreating a sibling")
  } finally {
    await app?.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

for (const touch of [false, true]) for (const [width, height] of [[320, 740], [360, 740], [390, 844], [430, 932], [932, 430]]) {
  test(`composer controls fit ${width}px ${touch ? "touch" : "mouse"} with a preserved draft`, async (t) => {
    const page = await browser.newPage({ ...(touch ? devices["Pixel 5"] : {}), viewport: { width, height } })
    const diagnostics = observeHeaderFixture(page)
    await runWithDiagnosticCleanup({
      run: async () => {
        await page.route("**/api/**", route => route.fulfill({ json: {} }))
        await diagnostics.install()
        await page.goto(url)
        await page.waitForFunction(() => Boolean((window as any).fixture))
        await page.evaluate(() => (window as any).fixture.setLocale("fr"))
        const input = page.locator("textarea.prompt-input")
        await input.fill("Brouillon mobile conservé")
        const geometry = await page.evaluate(() => {
          const footer = document.querySelector(".prompt-input-footer")!.getBoundingClientRect()
          const buttons = [...document.querySelectorAll<HTMLElement>(".prompt-context-controls .selector-trigger, .prompt-input-footer-actions button")]
            .filter(el => el.getBoundingClientRect().width > 0).map(el => {
              const r = el.getBoundingClientRect()
              return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
            })
          return { footer: { x: footer.x, right: footer.right, bottom: footer.bottom, width: footer.width }, buttons,
            selectors: [...document.querySelectorAll(".prompt-context-controls .selector-trigger")].map(el => el.getBoundingClientRect().y),
            actionsY: document.querySelector(".prompt-input-footer-actions")!.getBoundingClientRect().y }
        })
        for (const b of geometry.buttons) {
          assert.ok(b.x >= geometry.footer.x - 1 && b.right <= geometry.footer.right + 1 && b.bottom <= geometry.footer.bottom + 1, JSON.stringify(b))
          if (touch) assert.ok(b.width >= 32 && b.height >= 32, "dense touch controls retain compact targets")
        }
        for (let i = 0; i < geometry.buttons.length; i++) for (const b of geometry.buttons.slice(i + 1)) {
          const a = geometry.buttons[i]
          assert.ok(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, "controls must not overlap")
        }
        assert.equal(new Set(geometry.selectors).size, 1, "selectors retain one compact row")
        assert.ok(Math.abs(geometry.actionsY - geometry.selectors[0]) <= 1, "actions and selectors always share one row")
        if (width === 390) {
          const worktree = page.locator('.prompt-context-controls[data-has-worktree="true"] > .sidebar-selector').first().getByRole("button")
          assert.match(await worktree.innerText(), /Espace de travail/)
          await worktree.focus()
          await page.keyboard.press("ArrowDown")
          await page.getByRole("listbox").waitFor({ state: "visible" })
          await page.keyboard.press("Escape")
          await page.getByRole("listbox").waitFor({ state: "hidden" })
          assert.equal(await input.inputValue(), "Brouillon mobile conservé")
        }
        if (process.env.CODENOMAD_MOBILE_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_MOBILE_CAPTURE}/${touch ? "touch" : "mouse"}-${width}.png`, scale: "css" })
        await page.setViewportSize({ width: 600, height: 851 })
        assert.equal(await input.inputValue(), "Brouillon mobile conservé")
      },
      diagnose: () => diagnostics.diagnose(message => t.diagnostic(message)),
      cleanup: async () => { diagnostics.detach(); await page.close() },
      onObservationError: () => t.diagnostic("header diagnostic emission failed"),
      onCleanupError: () => t.diagnostic("header page cleanup failed after primary error"),
    })
  })
}

for (const device of ["Pixel 5", "iPhone 13", "Desktop Chrome"] as const) test(`timeline visibility follows conversation width on ${device}, independently of header density and height`, async () => {
  const page = await browser.newPage({ ...devices[device], viewport: { width: 1100, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    await page.getByText("Fixture message", { exact: true }).waitFor()
    const timeline = page.locator(".message-timeline-sidebar")
    await timeline.waitFor({ state: "attached" })
    // Constrain the real conversation container independently of the viewport
    // so docked sidebars and narrow desktop panes use the same breakpoint.
    await page.addStyleTag({ content: ".session-center-column { flex: 0 0 var(--fixture-center-width, 390px) !important; min-width: 0 !important; }" })
    for (const [width, height] of [[390, 844], [419, 844], [420, 844], [459, 844], [460, 844], [844, 390], [390, 400], [430, 932]]) {
      await page.locator(".session-center-column").evaluate((el, width) => (el as HTMLElement).style.setProperty("--fixture-center-width", `${width}px`), width)
      const expected = width >= 420
      await page.setViewportSize({ width, height })
      await page.evaluate(() => (window as any).fixture.setWorking())
      for (const density of [0, 4]) {
        const result = await page.locator(".session-center-column").evaluate((el, density) => {
          el.setAttribute("data-session-header-density", String(density))
          const rail = el.querySelector(".message-timeline-sidebar")!
          const view = el.querySelector(".session-view")!
          const worktree = el.querySelector('.prompt-context-controls[data-has-worktree="true"] > .sidebar-selector:first-child .selector-trigger')!
          const label = worktree.querySelector("div")!
          return { width: el.getBoundingClientRect().width, visible: rail.getBoundingClientRect().width > 0,
            worktreeWidth: worktree.getBoundingClientRect().width, worktreeLabelHidden: getComputedStyle(label).position === "absolute",
            padding: parseFloat(getComputedStyle(view).paddingInlineEnd),
            footer: getComputedStyle(el.querySelector(".prompt-input-footer")!, "::after").display }
        }, density)
        assert.equal(Math.round(result.width), width)
        assert.equal(result.visible, expected, JSON.stringify({ width, height, density, result }))
        assert.equal(result.padding > 0, expected, "hidden timeline leaves no reserved rail")
        assert.equal(result.worktreeLabelHidden, width < 460, "worktree label uses its own conversation-width breakpoint")
        if (width < 460) assert.equal(result.worktreeWidth, 32, "arrow-only worktree frees room for other selectors")
        if (!expected) assert.equal(result.footer, "none", "hidden rail leaves no footer extension")
      }
    }
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: false }))
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    assert.equal(await timeline.isVisible(), true)
  } finally { await page.close() }
})

test("short landscape composer shrinks, scrolls long drafts and shares pointer/keyboard resize limits", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const input = page.locator("textarea.prompt-input")
    const original = await input.evaluate(el => el.getBoundingClientRect().height)
    await page.setViewportSize({ width: 1800, height: 390 })
    await page.waitForFunction(height => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height < height, original)
    const draft = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n")
    await input.fill(draft)
    await page.waitForFunction(() => {
      const el = document.querySelector("textarea.prompt-input")!
      return el.clientHeight < 104 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"
    })
    const resize = page.locator(".prompt-resize-handle")
    await resize.focus()
    await page.keyboard.press("Home")
    const minimum = Number(await resize.getAttribute("aria-valuemin"))
    assert.equal(Number(await resize.getAttribute("aria-valuenow")), minimum)
    const bounds = await resize.boundingBox()
    assert.ok(bounds)
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 80)
    await page.mouse.up()
    assert.equal(Number(await resize.getAttribute("aria-valuenow")), minimum)
    assert.equal(await input.inputValue(), draft)
  } finally { await page.close() }
})

test("header actions collapse below the timeline breakpoint even when the full header fits", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.addStyleTag({ content: ".session-center-column { flex: 0 0 var(--fixture-width, 1000px) !important; min-width: 0 !important; }" })
    const center = page.locator(".session-center-column")
    await page.locator(".session-header-expanded-actions").waitFor({ state: "visible" })
    const search = page.locator('button[aria-controls^="session-search-"]')
    await search.focus()
    await center.evaluate(el => (el as HTMLElement).style.setProperty("--fixture-width", "419px"))
    await page.waitForFunction(() => document.activeElement?.classList.contains("session-header-actions-menu"))
    for (const width of [390, 419, 390]) {
      await center.evaluate((el, width) => (el as HTMLElement).style.setProperty("--fixture-width", `${width}px`), width)
      await page.waitForFunction(() => document.querySelector(".session-center-column")?.getAttribute("data-session-header-actions-forced") === "true")
      // Simulate the least dense header: width alone still forces the menu.
      await center.evaluate(el => el.setAttribute("data-session-header-density", "0"))
      assert.equal(await page.locator(".session-header-expanded-actions").isVisible(), false)
      const menu = page.locator(".session-header-actions-menu")
      await menu.click()
      await page.getByRole("menuitem", { name: "Message content", exact: true }).click()
      await page.locator(".transcript-filters").waitFor()
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.activeElement?.classList.contains("session-header-actions-menu"))
    }
    await center.evaluate(el => (el as HTMLElement).style.setProperty("--fixture-width", "420px"))
    await page.waitForFunction(() => document.querySelector(".session-center-column")?.getAttribute("data-session-header-actions-forced") === "false")
    await center.evaluate(el => (el as HTMLElement).style.setProperty("--fixture-width", "1000px"))
    await page.locator(".session-header-expanded-actions").waitFor({ state: "visible" })
    assert.equal(await page.locator(".session-header-actions-menu").isVisible(), false)
  } finally { await page.close() }
})

test("docked drawers can reduce the conversation to 390 CSS pixels before becoming overlays", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => {
      const f = (window as any).fixture
      if (!document.querySelector(".session-sidebar-container")) f.viewAction("view-left-panel")
      if (!document.querySelector(".session-right-panel")) f.viewAction("view-right-panel")
    })
    await page.setViewportSize({ width: 810, height: 1000 })
    await page.waitForFunction(() => Math.abs(document.querySelector(".session-center-column")!.getBoundingClientRect().width - 390) <= 1)
  } finally { await page.close() }
})

test("manual prompt height follows the pointer without changing its minimum as the draft grows", async () => {
  const page = await browser.newPage({ viewport: { width: 701, height: 1275 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const input = page.locator("textarea.prompt-input")
    const resize = page.locator(".prompt-resize-handle")
    const minimum = await page.locator(".session-center-column").evaluate(el => Math.max(44, Math.floor(el.getBoundingClientRect().height * 0.08)))
    await resize.focus()
    await page.keyboard.press("Home")
    await page.keyboard.press("ArrowUp")
    const chosen = Number(await resize.getAttribute("aria-valuenow"))
    await input.fill(Array.from({ length: 20 }, (_, i) => `Draft line ${i}`).join("\n"))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await input.evaluate(el => el.getBoundingClientRect().height), chosen, "typing must not raise a manually chosen height")
    const bounds = await resize.boundingBox()
    assert.ok(bounds)
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (const delta of [20, 80, 40, -80]) {
      await page.mouse.move(x, y - delta)
      const expected = Math.max(minimum, chosen + delta)
      await page.waitForFunction(expected => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height === expected, expected)
    }
    await page.mouse.up()
    assert.equal(Number(await resize.getAttribute("aria-valuemin")), minimum, "a tall narrow window uses the same proportional rule")
    assert.equal(await input.evaluate(el => getComputedStyle(el).overflowY), "auto")
  } finally { await page.close() }
})

test("chosen prompt proportion follows window height and survives composer remounts", async () => {
  const page = await browser.newPage({ viewport: { width: 701, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const input = page.locator("textarea.prompt-input")
    const resize = page.locator(".prompt-resize-handle")
    await input.fill("Keep my draft while resizing")
    await resize.focus()
    await page.keyboard.press("Home")
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowUp")
    const saved = await page.evaluate(() => (window as any).fixture.promptHeight())
    assert.ok(saved.ratio > 0.2 && saved.ratio < 0.4, `choose a height away from both bounds: ${saved.ratio}`)
    for (const height of [650, 1100, 390, 1275, 900]) {
      await page.setViewportSize({ width: 701, height })
      await page.waitForFunction(ratio => {
        const available = document.querySelector(".session-center-column")!.getBoundingClientRect().height
        const actual = document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height
        return actual === Math.max(44, Math.round(available * ratio))
      }, saved.ratio)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
    }
    const before = await input.evaluate(el => el.getBoundingClientRect().height)
    await page.evaluate(() => (window as any).fixture.showInfo())
    await page.evaluate(() => (window as any).fixture.showSession())
    await page.waitForFunction(height => document.querySelector("textarea.prompt-input")?.getBoundingClientRect().height === height, before)
    assert.equal(await input.inputValue(), "Keep my draft while resizing")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
  } finally { await page.close() }
})

test("visual keyboard shrink clamps the displayed manual height without overwriting it", async () => {
  const page = await browser.newPage({ viewport: { width: 932, height: 900 } })
  await page.addInitScript(`(() => {
    let height = window.innerHeight
    Object.defineProperty(window.visualViewport, "height", { get: () => height })
    window.setKeyboardViewport = (next) => {
      height = next
      window.visualViewport.dispatchEvent(new Event("resize"))
    }
  })()`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const input = page.locator("textarea.prompt-input")
    await input.fill("Draft stays here")
    await page.locator(".prompt-resize-handle").focus()
    await page.keyboard.press("End")
    const saved = await page.evaluate(() => (window as any).fixture.promptHeight())
    const original = await input.evaluate(el => el.getBoundingClientRect().height)
    assert.ok(original > 104)
    await page.evaluate(() => (window as any).setKeyboardViewport(320))
    await page.waitForFunction(height => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height < height, original)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
    assert.equal(await page.evaluate(() => innerHeight), 900, "keyboard changes only the visual viewport")
    await page.evaluate(() => (window as any).setKeyboardViewport(900))
    await page.waitForFunction(height => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height === height, original)
    assert.equal(await input.inputValue(), "Draft stays here")
  } finally { await page.close() }
})

test("context text never overlaps header actions after usage and session changes", async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 390, height: 844 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setLocale("fr"))
    for (const width of [390, 420, 460, 360]) {
      await page.setViewportSize({ width, height: 844 })
      for (const used of [0, 14000, 272000]) for (const working of [true, false]) {
        await page.evaluate(used => {
          const f = (window as any).fixture
          f.showInfo()
          f.setContext(used, 272000)
          f.showSession()
        }, used)
        await page.evaluate(working => working ? (window as any).fixture.setWorking() : (window as any).fixture.setIdle(), working)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))))
        const geometry = await page.evaluate(() => {
          const meter = document.querySelector(".context-meter")!
          const actions = document.querySelector(".session-header-actions-slot")!.getBoundingClientRect()
          const rects = [...meter.querySelectorAll("span, svg")].map(el => el.getBoundingClientRect()).filter(r => r.width > 0)
          const indicators = document.querySelector(".session-header-indicators")!.getBoundingClientRect()
          return { right: Math.max(...rects.map(r => r.right)), left: actions.left,
            indicators: { left: indicators.left, right: indicators.right, width: indicators.width },
            density: document.querySelector(".session-center-column")!.getAttribute("data-session-header-density") }
        })
        assert.ok(geometry.right + 4 <= geometry.left, JSON.stringify({ width, used, geometry }))
        if (geometry.indicators.width) assert.ok(geometry.right + 4 <= geometry.indicators.left && geometry.indicators.right + 4 <= geometry.left, JSON.stringify({ width, used, working, geometry }))
      }
    }
  } finally { await page.close() }
})

test("desktop timeline still follows its saved visibility preference", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    const timeline = page.locator(".message-timeline-sidebar")
    await timeline.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: false }))
    await timeline.waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    await timeline.waitFor({ state: "visible" })
  } finally { await page.close() }
})

test("content filters join the measured header overflow and restore keyboard focus", async () => {
  const page = await browser.newPage({ viewport: { width: 280, height: 844 }, hasTouch: true })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setWorking())
    const menu = page.locator(".session-header-actions-menu")
    await menu.waitFor({ state: "visible" })
    assert.equal(await page.locator(".transcript-filters-trigger").isVisible(), false)
    await menu.click()
    await page.getByRole("menuitem", { name: "Message content", exact: true }).click()
    const filters = page.locator(".transcript-filters")
    await filters.waitFor()
    const bounds = await filters.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 281, "filters stay inside the narrow viewport")
    await page.keyboard.press("Escape")
    await filters.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.classList.contains("session-header-actions-menu"))
    await page.setViewportSize({ width: 1800, height: 1000 })
    const direct = page.locator(".transcript-filters-trigger")
    await direct.waitFor({ state: "visible" })
    await direct.click()
    await filters.waitFor()
    await page.locator("#outside").click()
    await filters.waitFor({ state: "hidden" })
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

async function dragWindow(page: Page, panel: Locator, dx: number, dy: number) {
  const handle = await panel.locator("[data-window-drag-handle]").boundingBox()
  assert.ok(handle)
  await page.mouse.move(handle.x + handle.width - 4, handle.y + 4)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width - 4 + dx, handle.y + 4 + dy, { steps: 5 })
  await page.mouse.up()
  return (await panel.boundingBox())!
}

for (const kind of ["command-palette", "session-search"]) test(`${kind} stays visible when content grows after dragging`, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: route.request().url().endsWith("/session-history/query")
    ? { status: "page", scanned: 32, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
        hits: Array.from({ length: 32 }, (_, i) => ({ sessionID: "session", messageID: "hello", partIndex: i,
          kind: "text", role: "user", excerpt: `fixture result ${i}` })) }
    : {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.keyboard.press(kind === "command-palette" ? "Control+Shift+p" : "Control+f")
    const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
    const input = panel.locator(kind === "session-search" ? 'input[type="search"]' : 'input[type="text"]')
    if (kind === "command-palette") await input.fill("no-such-command")
    const before = await dragWindow(page, panel, 0, 2000)
    await input.fill("fixture")
    if (kind === "session-search") await panel.locator(".history-search-result").first().waitFor()
    await page.waitForFunction(({ id, height }) => {
      const r = document.getElementById(id!)!.getBoundingClientRect()
      return r.height > height && r.bottom <= innerHeight && r.top >= 0
    }, { id: await panel.getAttribute("id"), height: before.height })
    if (kind === "session-search") {
      await page.setViewportSize({ width: 932, height: 390 })
      const raised = await dragWindow(page, panel, 0, -2000)
      assert.ok(raised.height > 390 && raised.y >= 16, "oversized landscape search retains its top bar")
      assert.equal(await panel.locator(".window-close-button").evaluate(el => {
        const r = el.getBoundingClientRect()
        return r.y >= 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }), true)
      const recovered = await dragWindow(page, panel, -40, 40)
      assert.ok(Math.abs(recovered.x - raised.x + 40) < 1, "the visible bar can still move the oversized search")
      await panel.locator(".window-close-button").click()
      await panel.waitFor({ state: "hidden" })
    }
  } finally { await page.close() }
})

for (const kind of ["command-palette", "session-search"]) test(`${kind} close remains reachable after native zoom and pan`, async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 390, height: 844 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.keyboard.press(kind === "command-palette" ? "Control+Shift+p" : "Control+f")
    const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
    await panel.waitFor()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
    for (let i = 0; i < 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 50 }] })
      for (const x of [150, 120, 90, 60, 30]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 50 }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const close = await panel.locator(".window-close-button").evaluate(el => {
      const r = el.getBoundingClientRect(), v = window.visualViewport!
      return { left: v.offsetLeft, reachable: r.x >= v.offsetLeft && r.right <= v.offsetLeft + v.width,
        hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }
    })
    assert.ok(close.left >= 179 && close.reachable && close.hit, JSON.stringify(close))
    await cdp.detach()
  } finally { await page.close() }
})

test("ported search opens inside the viewport with asymmetric drawers", async () => {
  const page = await browser.newPage({ viewport: { width: 810, height: 600 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.viewAction("view-right-panel"))
    await page.keyboard.press("Control+f")
    const panel = page.locator('[role="dialog"][id^="session-search-"]')
    await panel.waitFor()
    const bounds = (await panel.boundingBox())!, close = (await panel.locator(".window-close-button").boundingBox())!
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 810 && close.x + close.width <= 810)
    assert.equal(await panel.locator(".window-close-button").evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }), true)
  } finally { await page.close() }
})

for (const first of ["command-palette", "session-search"]) test(`new utility window remains above the older ${first}`, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const second = first === "command-palette" ? "session-search" : "command-palette"
    for (const kind of [first, second]) await page.keyboard.press(kind === "command-palette" ? "Control+Shift+p" : "Control+f")
    const older = page.locator(`[role="dialog"][id^="${first}-"]`), active = page.locator(`[role="dialog"][id^="${second}-"]`)
    const a = (await older.boundingBox())!, b = (await active.boundingBox())!
    await dragWindow(page, active, a.x - b.x, a.y - b.y)
    assert.equal(await active.locator(".window-close-button").evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }), true)
    await page.keyboard.press("Escape")
    await active.waitFor({ state: "hidden" })
    assert.equal(await older.isVisible(), true)
  } finally { await page.close() }
})

for (const kind of ["command-palette", "session-search"]) test(`${kind} stays open outside, marks its toggle, and closes explicitly`, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const trigger = page.locator(`button[aria-controls^="${kind}-"]`)
    await trigger.waitFor()
    const id = await trigger.getAttribute("aria-controls")
    const panel = page.locator(`[id="${id}"]`)
    await trigger.click()
    await panel.waitFor()
    const close = panel.locator(".window-close-button")
    assert.equal(await panel.locator(".window-header").count(), 0, "reuse the existing toolbar without another header")
    assert.equal(await close.count(), 1)
    const bounds = await panel.boundingBox()
    const closeBounds = await close.boundingBox()
    assert.ok(bounds && closeBounds && closeBounds.y < bounds.y + 50 && closeBounds.x > bounds.x + bounds.width / 2, "close is in the upper-right header")
    await close.focus()
    await page.keyboard.press("Enter")
    await panel.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).fixture.executions()), 0, "closing must not execute a palette command")
    await trigger.click()
    await panel.waitFor()
    assert.equal(await trigger.getAttribute("aria-expanded"), "true")
    assert.notEqual(await trigger.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)")
    assert.equal(await page.locator(".modal-overlay").count(), 0)
    assert.notEqual(await panel.getAttribute("aria-modal"), "true")
    const before = (await panel.boundingBox())!, moved = await dragWindow(page, panel, 60, 40)
    assert.ok(Math.abs(moved.x - before.x - 60) < 1 && Math.abs(moved.y - before.y - 40) < 1, JSON.stringify({ before, moved }))
    await dragWindow(page, panel, 2000, 2000)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.waitForFunction(id => {
      const r = document.getElementById(id!)!.getBoundingClientRect()
      return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }, id)
    const resizedBounds = (await panel.boundingBox())!
    assert.ok(resizedBounds.x >= 0 && resizedBounds.y >= 0 && resizedBounds.x + resizedBounds.width <= 900 && resizedBounds.y + resizedBounds.height <= 700)
    assert.equal(await panel.locator("[data-window-drag-handle]").evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.right - 4, r.y + 4))
    }), true, "moved bar remains reachable")
    await page.setViewportSize({ width: 1800, height: 1000 })
    await trigger.click()
    await panel.waitFor({ state: "hidden" })
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    await trigger.click()
    await panel.waitFor()
    await page.locator("#outside").click()
    assert.equal(await panel.isVisible(), true)
    assert.equal(await page.locator("#outside").evaluate(el => el === document.activeElement), true)
    await trigger.click()
    await panel.waitFor({ state: "hidden" })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await panel.waitFor()
    await page.keyboard.press("Escape")
    await panel.waitFor({ state: "hidden" })
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    await page.waitForFunction(id => document.querySelector(`button[aria-controls="${id}"]`) === document.activeElement, id)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("search shortcut, session changes and palette execution keep their own authority", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const search = page.locator('button[aria-controls^="session-search-"]')
    await page.keyboard.press("Control+f")
    await page.getByRole("searchbox").waitFor()
    assert.equal(await search.getAttribute("aria-expanded"), "true")
    await page.getByRole("searchbox").fill("fixture")
    await dragWindow(page, page.locator('[role="dialog"][id^="session-search-"]'), 40, 30)
    await page.locator("#outside").click()
    assert.equal(await page.getByRole("searchbox").inputValue(), "fixture")
    await page.evaluate(() => (window as any).fixture.showInfo())
    await page.getByRole("searchbox").waitFor({ state: "hidden" })
    await page.locator('button[aria-controls^="command-palette-"]').click()
    const palette = page.locator('[role="dialog"][id^="command-palette-"]')
    await palette.waitFor()
    await palette.getByRole("textbox").fill("Fixture command")
    await dragWindow(page, palette, 40, 30)
    assert.equal(await palette.getByRole("textbox").inputValue(), "Fixture command")
    await page.keyboard.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).fixture.executions()), 1)
  } finally { await page.close() }
})

test("compact touch controls can reopen their menu and explicitly toggle a persistent window", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: true })
  const page = await context.newPage()
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const menu = page.locator(".session-header-actions-menu")
    // Exercise the real overflow controls independently of the shell's density
    // measurement (the fixture has no runtime status indicators).
    await page.addStyleTag({ content: ".session-header-expanded-actions { display: none !important; } .session-header-actions-menu.action-overflow-trigger { display: inline-flex !important; }" })
    for (const kind of ["command-palette", "session-search"]) {
      await menu.tap()
      const action = page.getByRole("menuitemcheckbox").nth(kind === "command-palette" ? 0 : 1)
      await action.tap()
      const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
      await panel.waitFor()
      const bar = (await panel.locator("[data-window-drag-handle]").boundingBox())!, before = (await panel.boundingBox())!
      const cdp = await context.newCDPSession(page)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bar.x + bar.width - 4, y: bar.y + 4 }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bar.x + bar.width - 4, y: bar.y + 34 }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await cdp.detach()
      assert.ok(Math.abs((await panel.boundingBox())!.y - before.y - 30) < 1, "top bar supports native touch dragging")
      await page.locator("#outside").tap()
      assert.equal(await panel.isVisible(), true)
      await panel.locator(".window-close-button").tap()
      await panel.waitFor({ state: "hidden" })
    }
  } finally { await context.close() }
})

test("utility windows remain visible and keyboard accessible in RTL", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setLocale("he"))
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    for (const kind of ["command-palette", "session-search"]) {
      await page.locator(".session-header-actions-menu").click()
      await page.getByRole("menuitemcheckbox").nth(kind === "command-palette" ? 0 : 1).click()
      const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
      await panel.waitFor()
      const bounds = await panel.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1800, `${kind} fits the viewport`)
      if (kind === "session-search") {
        const host = await page.locator(".session-center-column").boundingBox()
        assert.ok(host && bounds.x >= host.x && bounds.x + bounds.width <= host.x + host.width, "search is not clipped by the transcript")
      }
      await page.waitForFunction(({ id, selector }) => document.querySelector(`[id="${id}"] ${selector}`) === document.activeElement,
         { id: await panel.getAttribute("id"), selector: kind === "session-search" ? 'input[type="search"]' : "input" })
      const moved = await dragWindow(page, panel, 45, 35)
      assert.ok(bounds && Math.abs(moved.x - bounds.x - 45) < 1 && Math.abs(moved.y - bounds.y - 35) < 1, "RTL uses physical pointer coordinates")
      if (process.env.CODENOMAD_HEADER_CAPTURE_DIR) await page.screenshot({ path: `${process.env.CODENOMAD_HEADER_CAPTURE_DIR}/${kind}-rtl.png` })
      await page.keyboard.press("Escape")
      await panel.waitFor({ state: "hidden" })
    }
  } finally { await page.close() }
})

test("Escape consumes only the top utility window before the global Stop shortcut", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setWorking())
    await page.keyboard.press("Control+Shift+p")
    const palette = page.locator('[role="dialog"][id^="command-palette-"]')
    await palette.waitFor()
    await page.keyboard.press("Control+f")
    const search = page.getByRole("searchbox")
    await search.waitFor()
    await page.locator("#outside").click()
    await page.keyboard.press("Escape")
    await search.waitFor({ state: "hidden" })
    assert.equal(await palette.isVisible(), true, "one Escape must not dismiss both layers")
    await page.keyboard.press("Escape")
    await palette.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).fixture.escapeStates().includes(true)), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.interrupts()), 0)
    // After explicit window dismissal, the usual double-Escape still works.
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate(() => (window as any).fixture.escapeStates().at(-1)), true)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => (window as any).fixture.interrupts() === 1)
  } finally { await page.close() }
})

test("repeated palette shortcut refocuses its input without erasing the query or editing the composer", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.keyboard.press("Control+Shift+p")
    const input = page.locator('[role="dialog"][id^="command-palette-"] input')
    await input.fill("Fixture")
    const composer = page.locator("textarea.prompt-input")
    await composer.fill("Draft to preserve")
    await page.keyboard.press("Control+Shift+p")
    await page.waitForFunction(() => document.activeElement?.matches('[id^="command-palette-"] input'))
    assert.equal(await input.inputValue(), "Fixture")
    await page.keyboard.press("End")
    await page.keyboard.type(" command")
    assert.equal(await input.inputValue(), "Fixture command")
    assert.equal(await composer.inputValue(), "Draft to preserve")
  } finally { await page.close() }
})

test("web preview close returns to the conversation with its draft and can reopen", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/previews", route => route.fulfill({ json: {
    sessionId: "session", token: "fixture-preview", targetUrl: "http://localhost:3000", createdAt: 1,
  } }))
  await page.route("**/previews/fixture-preview**", route => route.fulfill({ contentType: "text/html", body: "<p>Preview fixture</p>" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const composer = page.locator("textarea.prompt-input")
    await composer.fill("Draft to preserve")
    const toggle = page.locator('button[title="Open web preview"]')
    await toggle.click()
    const preview = page.locator(".window-shell").filter({ has: page.locator("iframe") })
    const close = preview.locator(".window-close-button")
    await close.waitFor()
    assert.equal(await preview.locator(".window-header").count(), 0, "web preview reuses its navigation toolbar")
    await close.click()
    await preview.waitFor({ state: "hidden" })
    assert.equal(await composer.inputValue(), "Draft to preserve")
    await toggle.click()
    await close.waitFor()
    await close.click()
    await preview.waitFor({ state: "hidden" })
  } finally { await page.close() }
})
