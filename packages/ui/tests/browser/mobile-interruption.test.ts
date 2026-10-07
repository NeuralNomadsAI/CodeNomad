import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium, devices, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>> | undefined
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ cacheDir: cache.cacheDir, configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
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
after(async () => {
  try { await browser?.close() }
  finally {
    try { await server?.close() }
    finally { await cache?.dispose() }
  }
})

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
  test(`Android ${size} keeps descendant and explicitly opened global forms reachable above a saved maximum composer`, async () => {
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
        f.addSession("background", "session")
        f.nativeQuestion("background", "background-form", true)
      })
      if (size === "keyboard") {
        await page.evaluate(() => (window as any).keyboardViewport(393))
        await page.waitForFunction(() => document.querySelector(".content-area")!.getBoundingClientRect().bottom <= 393)
        assert.equal(await page.evaluate(() => innerHeight), 851)
      }
      for (const request of ["background", "global"]) {
        if (request === "global") {
          await page.evaluate(() => (window as any).fixture.nativeQuestion("global", "global-form", true))
          assert.equal(await page.locator('.interruption-dock').isVisible(), true)
          assert.equal(await page.locator('.interruption-dock input:visible').count(), 0)
          await page.locator('.session-header-indicators .permission-center-trigger:visible').click()
          assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "session")
          assert.equal(await page.getByRole('heading', { name: 'Project request', exact: true }).isVisible(), true)
          assert.equal(await page.getByRole('button', { name: 'View conversation', exact: true }).count(), 0)
        }
        const fields = page.locator(".interruption-dock .form-request-fields")
        assert.equal(await fields.evaluate(el => el.scrollHeight > el.clientHeight), true)
        await assertFooter(page)
        const answer = page.locator('.interruption-dock input[type="text"]:visible')
        await answer.fill(`Answer ${request}`)
        await assertReachable(answer)
        await assertFooter(page)
        assert.equal(await composer.inputValue(), draft)
        assert.equal(await composer.isDisabled(), false, "descendant/global requests compact their own surface's composer")
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
        if (request === "global") await page.evaluate(() => (window as any).fixture.selectSession("session"))
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

for (const mobile of [false, true]) {
  for (const owner of ["unrelated", "global"]) {
    test(`Info badge opens the ${owner} request on the conversation surface without owner navigation on ${mobile ? "mobile" : "desktop"}`, async () => {
      const page = await browser.newPage(mobile ? { ...devices["Pixel 5"] } : { viewport: { width: 1400, height: 900 } })
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      try {
        await page.goto(url, { timeout: 60000 })
        await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 60000 })
        await page.locator('textarea.prompt-input:visible').fill("Original conversation draft")
        await page.evaluate(owner => {
          const f = (window as any).fixture
          if (owner !== "global") f.addSession(owner)
          f.nativeQuestion(owner)
          f.showInfo()
        }, owner)
        assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "info")
        assert.equal(await page.locator('.interruption-dock:visible').count(), 0)
        await page.locator('.session-header-indicators .permission-center-trigger:visible').click()
        // The existing Back to conversation behavior uses the no-session surface
        // when Info has no mounted conversation pane; never infer the request owner.
        assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), null)
        const answer = page.locator('.interruption-dock input[type="text"]:visible')
        await answer.waitFor()
        assert.equal(await page.locator('.interruption-dock').evaluate(el => el === document.activeElement), true)
        assert.equal(await page.getByRole('heading', {
          name: owner === "global" ? "Project request" : "Other conversation · Fixture unrelated", exact: true,
        }).isVisible(), true)
        assert.equal(await page.getByRole('button', { name: 'View conversation', exact: true }).count(), owner === "global" ? 0 : 1)
        await answer.fill("Answer from Info")
        await page.getByRole('button', { name: 'Submit', exact: true }).click()
        assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].sessionID), owner)
        assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), null)
        await page.evaluate(() => (window as any).fixture.selectSession("session"))
        assert.equal(await page.locator('textarea.prompt-input:visible').inputValue(), "Original conversation draft")
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    })
  }

  test(`real shell keeps a focused local draft and one bounded foreign preview on ${mobile ? "mobile" : "desktop"}`, async () => {
    const page = await browser.newPage(mobile ? { ...devices["Pixel 5"] } : { viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 60000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 60000 })
      const answer = page.locator('.interruption-dock input[type="text"]:visible')
      await page.evaluate(() => (window as any).fixture.nativeQuestion())
      await answer.fill("Focused local draft")
      await page.evaluate(() => {
        const f = (window as any).fixture
        for (let i = 0; i < 20; i++) {
          f.addSession(`foreign-${i}`)
          f.nativeQuestion(`foreign-${i}`)
        }
        // A permission may sort before the current Form, even with the same ID.
        f.queuePermission("foreign-0", "question-session")
        f.nativeQuestion()
      })
      assert.equal(await answer.inputValue(), "Focused local draft")
      assert.equal(await answer.evaluate(el => el === document.activeElement), true)
      assert.equal(await page.locator('.interruption-external-preview').count(), 1)
      assert.equal(await page.locator('.interruption-external-preview .interruption-position').innerText(), "21")
      assert.equal(await page.locator('.interruption-editor:not([hidden])').count(), 1)
      assert.equal(await page.locator('.interruption-editor[hidden][inert]').count(), 21)
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "session")
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `external-${mobile ? "portrait" : "desktop"}-alongside-local.png`), scale: "css" })
      }
      await page.locator('.interruption-external-preview').focus()
      await page.keyboard.press("Enter")
      assert.equal(await page.locator('.interruption-dock').evaluate(el => el === document.activeElement), true,
        "opening a preview keeps keyboard focus in the dock after the compact button is removed")
      assert.equal(await page.getByRole('heading', { name: 'Other conversation · Fixture foreign-0', exact: true }).isVisible(), true)
      await page.locator('.interruption-dock textarea:visible').fill("Foreign permission reason")
      await page.getByRole('button', { name: 'Collapse requests', exact: true }).click()
      assert.equal(await page.locator('.interruption-heading > .lucide-shield-check').count(), 1)
      assert.equal(await page.locator('.interruption-dock .window-actions .session-permission').textContent(), 'Needs Permission')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `external-${mobile ? "portrait" : "desktop"}-permission-compact.png`), scale: "css" })
      }
      await page.locator('.interruption-dock .window-actions .session-permission').click()
      assert.equal(await page.locator('.interruption-dock textarea:visible').inputValue(), "Foreign permission reason")
      await page.getByRole('button', { name: 'Deny', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].sessionID), "foreign-0")
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].requestID), "question-session")
      assert.equal(await answer.inputValue(), "Focused local draft")
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[1].formID), "question-session")
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[1].sessionID), "session")
      assert.equal(await answer.count(), 0)
      assert.equal(await page.locator('.prompt-resize-handle').getAttribute('aria-disabled'), null)
      await page.getByRole('button', { name: 'Open request from Fixture foreign-0', exact: true }).click()
      await answer.fill("Foreign form draft")
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.nativeQuestion("foreign-0")
        f.nativeQuestion("session", "new-local")
      })
      assert.equal(await answer.inputValue(), "Foreign form draft")
      assert.equal(await answer.evaluate(el => el === document.activeElement), true)
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      assert.equal(await answer.count(), 0)
      await page.getByRole('button', { name: 'Previous request', exact: true }).click()
      assert.equal(await answer.count(), 0, "returning through navigation requires deliberate foreign expansion")
      await page.getByRole('button', { name: 'Open request from Fixture foreign-0', exact: true }).click()
      assert.equal(await answer.inputValue(), "Foreign form draft")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })

  test(`real shell labels recursive interruptions and preserves per-conversation selection on ${mobile ? "mobile" : "desktop"}`, async () => {
    const page = await browser.newPage(mobile ? { ...devices["Pixel 5"] } : { viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 60000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 60000 })
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.addSession("child", "session")
        f.addSession("grandchild", "child")
        f.addSession("sibling", "session")
        f.addSession("unrelated")
        for (const id of ["session", "child", "grandchild", "sibling", "unrelated"]) f.nativeQuestion(id)
      })
      const answer = page.locator('.interruption-dock input[type="text"]:visible')
      const heading = page.locator('.interruption-heading .window-title')
      const position = page.locator('.interruption-navigation .interruption-position')
      assert.equal(await page.locator('.interruption-session').innerText(), "Fixture conversation")
      assert.equal(await position.innerText(), "1 / 5")
      assert.equal(await page.locator('.interruption-external-preview').count(), 1)
      await answer.fill("Parent draft")
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      assert.equal(await heading.textContent(), "Subagent · Fixture child")
      assert.equal(await page.locator(".interruption-heading > .lucide-message-circle-question").count(), 1)
      assert.equal(await page.locator('.interruption-parent').innerText(), "From Fixture conversation")
      await answer.fill("Child draft")
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      assert.equal(await heading.textContent(), "Subagent · Fixture grandchild")
      assert.equal(await page.locator('.interruption-parent').innerText(), "From Fixture child")
      await answer.fill("Grandchild draft")
      await page.evaluate(() => (window as any).fixture.selectSession("child"))
      assert.equal(await page.locator('.interruption-session').innerText(), "Fixture child")
      assert.equal(await answer.inputValue(), "Child draft")
      assert.equal(await position.innerText(), "2 / 5")
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      assert.equal(await answer.inputValue(), "Grandchild draft")
      await answer.focus()
      await page.evaluate(() => (window as any).fixture.queuePermission("child"))
      assert.equal(await answer.inputValue(), "Grandchild draft")
      assert.equal(await answer.evaluate(el => el === document.activeElement), true)
      assert.equal(await position.innerText(), "4 / 6")
      await page.evaluate(() => (window as any).fixture.focusRequest("child", "dock-permission"))
      await page.locator('.interruption-dock textarea:visible').fill("Child permission draft")
      await page.evaluate(() => (window as any).fixture.selectSession("unrelated"))
      await page.evaluate(() => (window as any).fixture.selectSession("child"))
      assert.equal(await page.locator('.interruption-dock textarea:visible').inputValue(), "Child permission draft")
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      await page.getByRole('button', { name: 'Next request', exact: true }).click()

      await page.evaluate(() => (window as any).fixture.selectSession("grandchild"))
      assert.equal(await answer.inputValue(), "Grandchild draft")
      assert.equal(await position.innerText(), "4 / 6", "parents and siblings remain answerable through compact previews")
      await page.evaluate(() => (window as any).fixture.selectSession("unrelated"))
      assert.equal(await page.locator('.interruption-session').innerText(), "Fixture unrelated")
      assert.equal(await position.innerText(), "6 / 6")
      await answer.fill("Unrelated draft")
      await page.evaluate(() => (window as any).fixture.selectSession("child"))
      assert.equal(await heading.textContent(), "Subagent · Fixture grandchild", "child conversation restores its selected descendant")
      assert.equal(await answer.inputValue(), "Grandchild draft")
      await page.evaluate(() => (window as any).fixture.selectSession("session"))
      assert.equal(await heading.textContent(), "Subagent · Fixture grandchild", "parent conversation restores its selection independently")

      // Reconciliation changes payload identity without replacing the mounted editor.
      await page.evaluate(() => (window as any).fixture.nativeQuestion("grandchild"))
      assert.equal(await answer.inputValue(), "Grandchild draft")
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].sessionID), "grandchild")
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "session")
      await page.evaluate(() => (window as any).fixture.selectSession("child"))
      assert.equal(await page.locator('.interruption-dock textarea:visible').inputValue(), "Child permission draft")
      await page.getByRole('button', { name: 'Deny', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[1].sessionID), "child")
      await page.evaluate(() => (window as any).fixture.selectSession("session"))
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      await page.getByRole('button', { name: 'View conversation', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "child")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })

  test(`real shell opens foreign requests in place with persistent provenance on ${mobile ? "mobile" : "desktop"}`, async () => {
    const page = await browser.newPage(mobile ? { ...devices["Pixel 5"] } : { viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url, { timeout: 60000 })
      await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 60000 })
      const dock = page.locator('.interruption-dock')
      const answer = page.locator('.interruption-dock input[type="text"]:visible')
      const badge = page.locator('.session-header-indicators .permission-center-trigger:visible')
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.addSession("unrelated")
        f.nativeQuestion("unrelated")
      })
      assert.equal(await dock.isVisible(), true)
      assert.equal(await answer.count(), 0)
      assert.equal(await page.getByRole('heading', { name: 'Other conversation · Fixture unrelated', exact: true }).isVisible(), true)
      assert.equal(await page.locator('.interruption-heading > .lucide-message-circle-question').count(), 1)
      assert.equal(await page.locator('.interruption-dock .window-actions .session-permission').textContent(), 'Needs Input')
      assert.ok((await dock.boundingBox())!.height < 80)
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "session")
      assert.equal(await page.locator('.prompt-resize-handle').getAttribute('aria-disabled'), null)
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await mkdir(process.env.CODENOMAD_MOBILE_CAPTURE, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `external-${mobile ? "portrait" : "desktop"}-compact.png`), scale: "css" })
      }
      await badge.click()
      await answer.fill("Owner draft")
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "session")
      assert.equal(await dock.evaluate(el => el.contains(document.activeElement)), true)
      assert.equal(await page.getByRole('heading', { name: 'Other conversation · Fixture unrelated', exact: true }).isVisible(), true)
      assert.equal(await page.getByRole('button', { name: 'View conversation', exact: true }).isVisible(), true)
      assert.equal(await page.locator('.interruption-origin-title').evaluate(el => {
        const source = getComputedStyle(el), kind = getComputedStyle(el.previousElementSibling!)
        return Number(source.fontWeight) >= 600 && parseFloat(source.fontSize) > parseFloat(kind.fontSize)
          && !el.closest('.interruption-body')
      }), true, "the actual source name is a prominent persistent heading outside the scrolling form")
      assert.equal(await page.locator('.prompt-resize-handle').getAttribute('aria-disabled'), 'true')
      if (process.env.CODENOMAD_MOBILE_CAPTURE) {
        await page.screenshot({ path: join(process.env.CODENOMAD_MOBILE_CAPTURE, `external-${mobile ? "portrait" : "desktop"}-expanded.png`), scale: "css" })
      }
      await page.evaluate(() => (window as any).fixture.nativeQuestion("global"))
      assert.equal(await page.locator('.interruption-navigation .interruption-position').innerText(), "1 / 2")
      assert.equal(await answer.inputValue(), "Owner draft")
      assert.equal(await answer.evaluate(el => el === document.activeElement), true)
      await page.getByRole('button', { name: 'Next request', exact: true }).click()
      assert.equal(await answer.count(), 0, "navigation to a foreign request is a preview, not permission to open its editor")
      assert.equal(await page.locator('.prompt-resize-handle').getAttribute('aria-disabled'), null)
      assert.equal(await page.getByRole('heading', { name: 'Project request', exact: true }).isVisible(), true)
      await page.getByRole('button', { name: 'Open request from Project request', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: 'View conversation', exact: true }).count(), 0)
      await answer.fill("Global draft")
      await page.evaluate(() => (window as any).fixture.selectSession(null))
      assert.equal(await answer.count(), 0, "global request on a new surface still requires explicit expansion")
      await page.evaluate(() => (window as any).fixture.selectSession("session"))
      assert.equal(await answer.inputValue(), "Global draft")
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[0].sessionID), "global")
      assert.equal(await answer.count(), 0, "settlement must not reopen the previously viewed foreign request")
      await page.getByRole('button', { name: 'Open request from Fixture unrelated', exact: true }).click()
      assert.equal(await answer.inputValue(), "Owner draft")
      await page.getByRole('button', { name: 'View conversation', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.selectedSession()), "unrelated")
      assert.equal(await answer.inputValue(), "Owner draft")
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[1].sessionID), "unrelated")
      assert.equal(await page.evaluate(() => (window as any).fixture.replies[1].formID), "question-unrelated")
      await page.evaluate(() => (window as any).fixture.selectSession("session"))
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.addSession("late-grandchild", "late-child")
        f.nativeQuestion("late-grandchild")
      })
      assert.equal(await answer.count(), 0)
      await page.evaluate(() => (window as any).fixture.addSession("late-child", "session"))
      assert.equal(await page.getByRole('heading', { name: 'Subagent · Fixture late-grandchild', exact: true }).isVisible(), true)
      // Classification changes alone preserve the compact selection.
      await page.getByRole('button', { name: 'Open request from Fixture late-grandchild', exact: true }).click()
      await answer.fill("Late draft")
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.focusRequest("late-grandchild", "already-settled")
      })
      assert.equal(await answer.inputValue(), "Late draft")
      assert.equal(await answer.evaluate(el => el === document.activeElement), true, "invalid focus intents cannot fall back to the current request")
      // Even a queued valid focus is fenced when the surface changes before its microtask.
      await page.evaluate(() => {
        const f = (window as any).fixture
        f.focusRequest("late-grandchild", "question-late-grandchild")
        f.selectSession("missing-session")
      })
      assert.equal(await answer.count(), 0)
      await page.evaluate(() => (window as any).fixture.showInfo())
      assert.equal(await answer.count(), 0)
      await page.evaluate(() => (window as any).fixture.selectSession(null))
      assert.equal(await answer.count(), 0)
      await page.evaluate(() => (window as any).fixture.selectSession("session"))
      assert.equal(await answer.inputValue(), "Late draft")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
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
        ;(window as any).fixture.addSession("foreign")
        ;(window as any).fixture.nativeQuestion("foreign", "short-keyboard-form", true)
      }, keyboardHeight)
      assert.equal(await page.locator('.interruption-dock input:visible').count(), 0)
      await page.getByRole('button', { name: 'Open request from Fixture foreign', exact: true }).click()
      await page.evaluate(keyboardHeight => {
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
        if (sid === "session") assert.equal(await answer.inputValue(), "Preserve my answer")
        else {
          assert.equal(await page.locator('.interruption-editor[hidden][inert] input').inputValue(), "Preserve my answer")
          assert.equal(await page.locator('.prompt-resize-handle').getAttribute('aria-disabled'), null)
          assert.equal(await composer.evaluate(el => el.getBoundingClientRect().height), originalHeight)
        }
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
