import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { chromium, devices, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string, cacheDir: string
before(async () => {
  cacheDir = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "codenomad-mobile-interruption-"))
  server = await createServer({ cacheDir, configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "mobile-interruption-fixture", configureServer(s) {
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
after(async () => { await browser?.close(); await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }) })

async function dockSnapshot(page: Page) {
  return page.evaluate(() => ({
    forms: (window as any).fixture?.pendingForms(),
    panes: [...document.querySelectorAll(".session-cache-pane")].map(el => ({
      session: el.getAttribute("data-session-id"), active: el.getAttribute("data-session-active"),
    })),
    docks: [...document.querySelectorAll(".interruption-dock")].map(el => {
      const rect = el.getBoundingClientRect()
      return { parent: el.parentElement?.className, session: el.closest("[data-session-id]")?.getAttribute("data-session-id"),
        width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom,
        children: [...el.querySelectorAll(".window-header, .interruption-body, .form-request-fields, .form-request-actions, input")].map(child => {
          const r = child.getBoundingClientRect()
          return { className: child.className, top: r.top, height: r.height, bottom: r.bottom }
        }) }
    }),
  }))
}

for (const size of ["portrait", "short", "keyboard"] as const) {
  test(`Android ${size} keeps long background/global forms and permission actions reachable above a saved maximum composer`, async () => {
    const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 393, height: size === "short" ? 393 : 851 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    if (size === "keyboard") await page.addInitScript(`(() => {
      let height = innerHeight, top = 0
      Object.defineProperties(window.visualViewport, { height: { get: () => height }, offsetTop: { get: () => top } })
      window.keyboardViewport = (nextHeight, nextTop = 0) => {
        height = nextHeight; top = nextTop
        visualViewport.dispatchEvent(new Event("resize"))
        visualViewport.dispatchEvent(new Event("scroll"))
      }
    })()`)
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 45000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 45000 })
      const composer = page.locator("textarea.prompt-input:visible"), resize = page.locator(".prompt-resize-handle")
      await composer.fill("Background request must preserve this draft\n".repeat(15))
      const draft = await composer.inputValue()
      await resize.focus()
      await page.keyboard.press("End")
      const originalHeight = await composer.evaluate(el => el.getBoundingClientRect().height)
      const saved = await page.evaluate(() => (window as any).fixture.promptHeight())
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.addSession("background")
        f.nativeQuestion("background", "background-form", true)
      })
      if (size === "keyboard") {
        await page.evaluate(() => (window as any).keyboardViewport(393))
        await page.waitForFunction(() => document.querySelector(".content-area")!.getBoundingClientRect().bottom <= 393)
        assert.equal(await page.evaluate(() => innerHeight), 851)
      }
      for (const request of ["background", "global"]) {
        if (request === "global") await page.evaluate(() => (window as any).fixture.nativeQuestion("global", "global-form", true))
        const fields = page.locator(".interruption-dock .form-request-fields")
        assert.equal(await fields.evaluate(el => el.scrollHeight > el.clientHeight), true)
        await assertFooter(page)
        const answer = page.locator('.interruption-dock input[type="text"]:visible')
        await answer.fill(`Answer ${request}`)
        await assertReachable(answer)
        await assertFooter(page)
        assert.equal(await composer.inputValue(), draft)
        assert.equal(await composer.isDisabled(), false, "background/global requests still compact the unrelated active composer")
        assert.equal(await resize.getAttribute("aria-disabled"), "true")
        if (size === "keyboard") {
          for (const immersive of [true, false]) {
            await page.evaluate(immersive => (window as any).fixture.setImmersive(immersive), immersive)
            await assertFooter(page)
          }
          await page.evaluate(() => (window as any).keyboardViewport(393, 60))
          await page.waitForFunction(() => Math.abs(document.querySelector(".content-area")!.getBoundingClientRect().bottom - 453) < 1)
          await assertReachable(answer)
          await assertFooter(page)
          await page.evaluate(() => (window as any).keyboardViewport(393))
        }
        await page.getByRole("button", { name: "Submit", exact: true }).click()
        await page.locator(".interruption-dock").waitFor({ state: "detached" })
        assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      }
      await page.evaluate(() => (window as any).fixture.queuePermission())
      await page.locator(".interruption-dock .tool-call-permission").waitFor()
      await assertFooter(page, ".tool-call-permission-buttons")
      const rejectReason = page.locator(".interruption-dock textarea")
      await rejectReason.fill("Not this command")
      await assertReachable(rejectReason)
      await assertFooter(page, ".tool-call-permission-buttons")
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `interruption-${size}-permission.png`), scale: "css" })
      }
      await page.getByRole("button", { name: "Deny", exact: true }).click()
      await page.locator(".interruption-dock").waitFor({ state: "detached" })
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      if (size === "keyboard") await page.evaluate(() => (window as any).keyboardViewport(851))
      await page.waitForFunction(height => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height === height, originalHeight)
      assert.equal(await composer.inputValue(), draft)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

async function assertReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded()
  assert.equal(await control.evaluate(el => {
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.width > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  }), true, "the actual control must receive pointer hit testing")
}

async function assertFooter(page: Page, selector = ".form-request-actions") {
  const metrics = await page.locator(`.interruption-dock ${selector}`).evaluate(el => {
    const r = el.getBoundingClientRect(), dock = el.closest(".interruption-dock")!.getBoundingClientRect()
    const bottom = (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight)
    return { bounded: r.top >= dock.top && r.bottom <= dock.bottom && r.bottom <= bottom,
      controls: [...el.querySelectorAll("button")].every(button => {
        const b = button.getBoundingClientRect()
        return b.top >= r.top && b.bottom <= r.bottom && button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2))
      }) }
  })
  assert.deepEqual(metrics, { bounded: true, controls: true })
}

// Exercise native nested scrolling rather than scrollIntoView: the field scrolls
// its long contents, and the outer stack exposes fixed actions when the keyboard
// leaves less room than the dock's usable minimum plus the composer.
async function revealByGesture(page: Page, control: Locator, touch: boolean) {
  const cdp = touch ? await page.context().newCDPSession(page) : undefined
  let stable = 0, previousTop: number | undefined
  try {
    for (let attempt = 0; attempt < 70; attempt++) {
      const target = await control.evaluate(el => {
        const r = el.getBoundingClientRect(), outer = el.closest(".session-view")!.getBoundingClientRect()
        const top = Math.max(outer.top, visualViewport?.offsetTop ?? 0)
        const bottom = Math.min(outer.bottom, (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight))
        const fields = el.closest(".form-request-fields, .interruption-permission-content")?.getBoundingClientRect()
        const withinFields = !fields || (r.top >= fields.top && r.bottom <= fields.bottom)
        const ready = withinFields && r.top >= top && r.bottom <= bottom && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        // First expose the inner scrollport, then scroll within it. Gestures on
        // visible dock chrome reach the stack without grabbing a drawer resizer
        // or continuing to edit/scroll the focused permission textarea.
        const inner = fields && fields.top >= top && fields.bottom <= bottom && !withinFields
        const wanted = inner ? r.y + r.height / 2 : fields && !withinFields ? fields.y + fields.height / 2 : r.y + r.height / 2
        const chrome = [...el.closest(".interruption-dock")!.querySelectorAll(".window-header, .window-footer")]
          .map(node => node.getBoundingClientRect()).map(r => ({ x: r.x, width: r.width, top: Math.max(top, r.top), bottom: Math.min(bottom, r.bottom) }))
          .filter(r => r.bottom - r.top > 8).sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0]
        const rect = inner ? fields : chrome ?? { x: outer.x, width: 24, top, bottom }
        const delta = wanted - (inner ? (rect.top + rect.bottom) / 2 : (top + bottom) / 2)
        return { ready, controlTop: r.top, x: rect.x + rect.width / 2,
          y: inner ? (rect.top + rect.bottom) / 2 : delta > 0 ? rect.bottom - 3 : rect.top + 3,
          delta, top: visualViewport?.offsetTop ?? 0, bottom }
      })
      if (target.ready) {
        stable = previousTop === target.controlTop ? stable + 1 : 0
        previousTop = target.controlTop
        if (stable >= 5) return
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        continue
      }
      stable = 0
      if (cdp) {
        const distance = Math.sign(target.delta) * Math.max(24, Math.min(80, Math.abs(target.delta)))
        const endY = Math.max(target.top + 2, Math.min(target.bottom - 2, target.y - distance))
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x, y: target.y }] })
        for (let step = 1; step <= 5; step++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x, y: target.y + (endY - target.y) * step / 5 }] })
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
        }
        await page.waitForTimeout(100) // Release a held drag, rather than a kinetic fling that consumes the next tap.
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      } else {
        await page.mouse.move(target.x, target.y)
        await page.mouse.wheel(0, Math.sign(target.delta) * Math.min(180, Math.abs(target.delta)))
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    assert.fail(`control was not reachable through ${touch ? "touch" : "wheel"}: ${JSON.stringify(await control.evaluate(el => {
      const r = el.getBoundingClientRect(), outer = el.closest(".session-view")!
      return { rect: r.toJSON(), outer: outer.getBoundingClientRect().toJSON(), scrollTop: outer.scrollTop, scrollHeight: outer.scrollHeight,
        hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.className }
    }))}`)
  } finally { await cdp?.detach() }
}

for (const landscape of [false, true]) for (const keyboardHeight of [260, 220, 180]) {
  test(`Android ${landscape ? "landscape touch" : "portrait wheel"} keyboard ${keyboardHeight}px scrolls the request stack without clipping actions`, async () => {
    const page = await browser.newPage({ ...devices["Pixel 5"], viewport: landscape ? { width: 851, height: 393 } : { width: 393, height: 851 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript(`(() => {
      let height = innerHeight
      Object.defineProperty(visualViewport, "height", { get: () => height })
      window.keyboardViewport = next => { height = next; visualViewport.dispatchEvent(new Event("resize")) }
    })()`)
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 45000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 45000 })
      const composer = page.locator("textarea.prompt-input:visible")
      await composer.fill("Saved maximum composer draft")
      await page.locator(".prompt-resize-handle").focus()
      await page.keyboard.press("End")
      const height = await composer.evaluate(el => el.getBoundingClientRect().height)
      const saved = await page.evaluate(() => (window as any).fixture.promptHeight())
      await page.evaluate(keyboardHeight => {
        ;(window as any).fixture.nativeQuestion("session", "short-keyboard-form", true)
        ;(window as any).keyboardViewport(keyboardHeight)
      }, keyboardHeight)
      await page.waitForFunction(bottom => document.querySelector(".content-area")!.getBoundingClientRect().bottom <= bottom, keyboardHeight)
      await page.waitForFunction(() => {
        const el = document.querySelector(".session-view")!
        return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"
      })
      const answer = page.locator('.interruption-dock input[type="text"]:visible')
      await revealByGesture(page, answer, landscape)
      await answer.tap()
      await answer.fill("Reachable with a short keyboard")
      const submit = page.getByRole("button", { name: "Submit", exact: true })
      await revealByGesture(page, submit, landscape)
      await assertFooter(page)
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `short-keyboard-${landscape ? "landscape" : "portrait"}-${keyboardHeight}.png`), scale: "css" })
      }
      await submit.tap()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies.length), 1, "the visible Submit receives the native tap")
      await page.locator(".interruption-dock").waitFor({ state: "detached" })
      await page.evaluate(() => (window as any).fixture.queuePermission())
      const reason = page.locator(".interruption-dock textarea")
      await revealByGesture(page, reason, landscape)
      await reason.fill("Permission still reachable")
      const deny = page.getByRole("button", { name: "Deny", exact: true })
      await revealByGesture(page, deny, landscape)
      await assertFooter(page, ".tool-call-permission-buttons")
      await deny.tap()
      await page.locator(".interruption-dock").waitFor({ state: "detached" })
      await page.evaluate(() => (window as any).keyboardViewport(innerHeight))
      await page.waitForFunction(height => document.querySelector("textarea.prompt-input")!.getBoundingClientRect().height === height, height)
      assert.equal(await composer.inputValue(), "Saved maximum composer draft")
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

for (const mode of ["desktop", "mobile", "immersive", "landscape"] as const) {
  test(`real shell pending question survives two-session navigation in ${mode}`, async (t) => {
    const mobile = mode !== "desktop"
    const page = await browser.newPage({ ...(mobile ? devices["Pixel 5"] : {}),
      viewport: mode === "desktop" ? { width: 1100, height: 800 } : mode === "landscape" ? { width: 851, height: 393 } : { width: 393, height: 851 },
    })
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 45000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 45000 })
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.runtimeEnv), {
        host: "web", platform: mobile ? "mobile" : "desktop", windowContext: "remote",
      })
      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), mobile)
      await page.evaluate(immersive => {
        const f = (window as any).fixture
        f.addSession("second")
        f.setImmersive(immersive)
      }, mode === "immersive")
      const composer = page.locator("textarea.prompt-input:visible")
      await composer.fill("Preserve first session draft")
      const resize = page.locator(".prompt-resize-handle")
      await resize.focus()
      await page.keyboard.press("End")
      const saved = await page.evaluate(() => (window as any).fixture.promptHeight())
      assert.deepEqual(saved, { ratio: 0.6 })
      const originalHeight = await composer.evaluate(el => el.getBoundingClientRect().height)
      for (const sid of ["second", "session"]) {
        await page.evaluate(sid => (window as any).fixture.selectSession(sid), sid)
        await page.locator(`.session-cache-pane[data-session-id="${sid}"][data-session-active="true"] textarea`).waitFor()
      }
      await page.evaluate(() => (window as any).fixture.nativeQuestion())
      const answer = page.locator('.interruption-dock input[type="text"]:visible')
      await answer.fill("Preserve my answer")
      assert.equal(await resize.getAttribute("aria-disabled"), "true")
      assert.ok(await composer.evaluate(el => el.getBoundingClientRect().height) < originalHeight)
      for (const sid of ["second", "session", "second", "session"]) {
        await page.evaluate(sid => (window as any).fixture.selectSession(sid), sid)
        await page.locator(`.session-cache-pane[data-session-id="${sid}"][data-session-active="true"] textarea`).waitFor()
        assert.equal(await page.locator(".interruption-dock:visible").count(), 1, JSON.stringify(await dockSnapshot(page)))
        assert.equal(await answer.inputValue(), "Preserve my answer")
      }
      if (mode !== "immersive") {
        await page.getByRole("button", { name: "Collapse requests", exact: true }).click()
        assert.equal(await composer.evaluate(el => el.getBoundingClientRect().height), originalHeight)
        await page.locator(".session-header-indicators .permission-center-trigger:visible").click()
        await answer.waitFor()
      }
      assert.equal(await composer.inputValue(), "Preserve first session draft")
      const bounds = await page.locator(".interruption-dock").boundingBox()
      assert.ok(bounds && bounds.height > 60 && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height, JSON.stringify(await dockSnapshot(page)))
      await page.evaluate(() => (window as any).fixture.setActive(false))
      await page.locator(".session-cache-pane").waitFor({ state: "detached" })
      await page.evaluate(() => (window as any).fixture.setActive(true))
      await answer.waitFor()
      assert.equal(await answer.inputValue(), "Preserve my answer")
      await resize.focus()
      await page.keyboard.press("Home")
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      await page.keyboard.press("End")
      await resize.dispatchEvent("dblclick")
      await resize.dispatchEvent("pointerdown", { pointerId: 1, clientY: 100 })
      await resize.dispatchEvent("pointermove", { pointerId: 1, clientY: 200 })
      await resize.dispatchEvent("pointerup", { pointerId: 1, clientY: 200 })
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      await page.keyboard.press("Tab")
      assert.equal(await resize.evaluate(el => el === document.activeElement), false, "an interrupted resize must not trap keyboard focus")
      await assertReachable(answer)
      await assertFooter(page)
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `interruption-${mode}-expanded.png`), scale: "css" })
      }
      await page.getByRole("button", { name: "Submit", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.pendingForms().length === 0)
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].answer.q0), "Preserve my answer")
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.promptHeight()), saved)
      assert.equal(await composer.evaluate(el => el.getBoundingClientRect().height), originalHeight)
      assert.deepEqual(errors, [])
    } catch (error) {
      t.diagnostic(JSON.stringify(await dockSnapshot(page)))
      t.diagnostic(JSON.stringify({ errors }))
      throw error
    } finally {
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `interruption-${mode}.png`) })
      }
      await page.close()
    }
  })
}
