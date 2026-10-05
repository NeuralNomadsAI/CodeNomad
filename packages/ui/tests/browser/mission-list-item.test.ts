import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string, cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
    logLevel: "error", plugins: [solid(), { name: "mission-list-fixture", configureServer(s) {
      s.middlewares.use("/mission-list-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-list-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-list-item.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-list-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })
async function prepare(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).missionListFixture))
}
const row = '[data-fixture="main"] .mission-list-item'
const trigger = `${row} .action-overflow-trigger`
async function width(page: Page, value: number, collapsed: boolean) {
  await page.evaluate(value => (window as any).missionListFixture.width(value), value)
  await page.waitForFunction(({ row, collapsed }) => document.querySelector(row)?.classList.contains("mission-list-item-overflow") === collapsed, { row, collapsed })
}

test("the pinned reader eye keeps keyboard focus while secondary actions move into overflow", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    await width(page, 520, false)
    const eye = page.locator(`${row} .mission-list-preview button`)
    await eye.focus()
    await width(page, 170, true)
    assert.equal(await eye.isVisible(), true)
    assert.equal(await eye.evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => (window as any).missionListFixture.refresh())
    assert.equal(await eye.evaluate(element => element === document.activeElement), true)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="selection"]')?.textContent === "read:1")
  } finally { await page.close() }
})

test("three-line rows keep actions visible and measured overflow stable at fractional zoom, RTL and touch", async () => {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, hasTouch: touch, deviceScaleFactor: 1.25, locale: "en-US" })
    try {
      await prepare(page)
      for (const dir of ["ltr", "rtl"]) for (const zoom of [0.8, 1, 1.25, 1.5]) {
        await page.evaluate(({ dir, zoom }) => { document.dir = dir; document.body.style.zoom = String(zoom) }, { dir, zoom })
        await width(page, 520, false)
        assert.equal(await page.locator(`${row} .mission-list-inline button:visible`).count(), 4)
        assert.equal(await page.locator(`${row} .mission-list-preview button:visible`).count(), 1)
        const geometry = await page.locator(row).evaluate(e => {
          const text = e.querySelector(".mission-list-text")!.getBoundingClientRect()
          const footer = e.querySelector(".mission-list-footer")!.getBoundingClientRect()
          return { separated: text.bottom <= footer.top + 0.5, radius: getComputedStyle(e).borderRadius }
        })
        assert.equal(geometry.separated, true)
        assert.equal(geometry.radius, "0px")
        if (process.env.CODENOMAD_MISSION_LIST_CAPTURE && !touch && dir === "ltr" && zoom === 1) {
          await page.screenshot({ path: `${process.env.CODENOMAD_MISSION_LIST_CAPTURE}-wide.png` })
        }
        await width(page, 170, true)
        assert.equal(await page.locator(`${row} .mission-list-inline`).evaluate(e => (e as HTMLElement).inert), true)
        assert.ok(await page.locator(`${row} .mission-list-inline`).evaluate(e => e.getBoundingClientRect().width) > 100)
        await page.waitForTimeout(150)
        assert.equal(await page.locator(row).evaluate(e => e.classList.contains("mission-list-item-overflow")), true)
        await page.locator(trigger).click()
        assert.equal(await page.getByRole("menuitem").count(), 4)
        assert.equal(await page.locator(`${row} .mission-list-preview button:visible`).count(), 1)
        if (process.env.CODENOMAD_MISSION_LIST_CAPTURE && !touch && dir === "ltr" && zoom === 1) {
          await page.screenshot({ path: `${process.env.CODENOMAD_MISSION_LIST_CAPTURE}-narrow.png` })
        }
        // Widening must not unmount a currently open menu.
        await page.evaluate(() => (window as any).missionListFixture.width(520))
        await page.waitForTimeout(80)
        assert.equal(await page.getByRole("menuitem").count(), 4)
        await page.keyboard.press("Escape")
        await width(page, 520, false)
        try {
          await page.waitForFunction(() => Boolean(document.activeElement?.closest(".mission-list-inline")), undefined, { timeout: 2000 })
        } catch {
          assert.fail(`${touch}/${dir}/${zoom}: focus ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300))}`)
        }
      }
    } finally { await page.close() }
  }
})

test("keyboard focus hands off, menu actions keep callbacks and disabled state, compact rows stay single-line", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    await width(page, 520, false)
    await page.locator(`${row} .mission-list-inline button`).first().focus()
    await width(page, 170, true)
    await page.waitForFunction(() => document.activeElement?.classList.contains("action-overflow-trigger"))
    await page.keyboard.press("Enter")
    await page.getByRole("menuitem").first().click()
    await page.waitForFunction(() => document.querySelector('[data-fixture="count"]')?.textContent === "1")
    await page.evaluate(() => (window as any).missionListFixture.disabled(true))
    await page.locator(trigger).click()
    assert.equal(await page.getByRole("menuitem").nth(2).getAttribute("aria-disabled"), "true")
    await page.keyboard.press("Escape")
    await width(page, 520, false)
    await page.evaluate(() => (window as any).missionListFixture.compact(true))
    await page.waitForTimeout(100)
    const aligned = await page.locator(row).evaluate(e => {
      const text = e.querySelector(".mission-list-text")!.getBoundingClientRect()
      const footer = e.querySelector(".mission-list-footer")!.getBoundingClientRect()
      return Math.abs(text.top + text.height / 2 - footer.top - footer.height / 2) < 1
    })
    assert.equal(aligned, true)
    await width(page, 170, true)
    await width(page, 520, false)
    await page.evaluate(() => {
      (window as any).missionListFixture.compact(false)
      ;(window as any).missionListFixture.focusAction(true)
    })
    await width(page, 170, true)
    await page.locator(trigger).click()
    await page.evaluate(() => (window as any).missionListFixture.width(520))
    await page.getByRole("menuitem").first().click()
    await page.waitForTimeout(100)
    assert.equal(await page.locator('[data-fixture="reader-focus"]').evaluate(e => e === document.activeElement), true)
  } finally { await page.close() }
})

test("recovery admits only once without a second controller", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  try {
    await prepare(page)
    await page.route("**/api/**/missions/**/recover", async route => {
      requests++
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ admitted: true }) })
    })
    const button = page.locator('[data-fixture="recovery"] .mission-list-inline button')
    await button.click()
    await page.waitForFunction(() => (document.querySelector('[data-fixture="recovery"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    assert.equal(requests, 1)
    assert.equal(await button.isDisabled(), true)
  } finally { await page.close() }
})

test("overflow recovery preserves pending/error feedback, never auto-replays, and allows an explicit retry", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  try {
    await prepare(page)
    await page.route("**/api/**/missions/**/recover", async route => {
      requests++
      if (requests === 1) {
        await pending
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "recovery-unknown", message: "private upstream detail" }) })
      } else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ admitted: true }) })
    })
    await width(page, 80, true)
    const recovery = page.locator('[data-fixture="recovery"]')
    await recovery.locator(".action-overflow-trigger").click()
    await page.getByRole("menuitem").click()
    await recovery.getByRole("status").waitFor()
    assert.equal(requests, 1)
    await recovery.locator(".mission-list-inline button").evaluate(button => (button as HTMLButtonElement).click())
    assert.equal(requests, 1)
    release()
    await recovery.getByRole("alert").waitFor()
    assert.ok(!(await recovery.textContent())?.includes("private upstream detail"))
    await page.waitForTimeout(100)
    assert.equal(requests, 1)
    await recovery.locator(".action-overflow-trigger").click()
    await page.getByRole("menuitem").click()
    await page.waitForFunction(() => (document.querySelector('[data-fixture="recovery"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    await recovery.getByRole("alert").waitFor({ state: "hidden" })
    assert.equal(requests, 2)
  } finally { release(); await page.close() }
})

test("history and cleanup preserve top-level disclosures while sharing item chrome", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    for (const feature of ["history", "cleanup"]) {
      const section = page.locator(`[data-fixture="${feature}"]`)
      await section.locator(".mission-disclosure-trigger").click()
      await section.locator(".mission-list-item").waitFor()
      assert.equal(await section.locator(".mission-disclosure-trigger").count(), 1)
      assert.equal(await section.locator(".mission-list-text").count(), 1)
    }
    const history = page.locator('[data-fixture="history"]')
    if (await history.locator(".mission-list-item").evaluate(e => e.classList.contains("mission-list-item-overflow"))) {
      await history.locator(".action-overflow-trigger").click()
      await page.getByRole("menuitem").click()
    } else await history.locator(".mission-list-preview button").click()
    await page.waitForFunction(() => document.querySelector('[data-fixture="count"]')?.textContent === "1")
  } finally { await page.close() }
})

test("intrinsic overflow thresholds do not oscillate in compact or full rows at fractional zoom", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    for (const compact of [false, true]) for (const zoom of [0.8, 0.9, 1.1, 1.25]) {
      await page.evaluate(({ compact, zoom }) => {
        (window as any).missionListFixture.compact(compact)
        document.body.style.zoom = String(zoom)
      }, { compact, zoom })
      await width(page, 520, false)
      const threshold = await page.locator(row).evaluate((element, { compact, zoom }) => {
        const footer = element.querySelector<HTMLElement>(".mission-list-footer")!
        const range = document.createRange()
        range.selectNodeContents(element.querySelector(".mission-list-status")!)
        const style = getComputedStyle(element)
        const required = (range.getBoundingClientRect().width + element.querySelector(".mission-list-inline")!.getBoundingClientRect().width
          + element.querySelector(".mission-list-preview")!.getBoundingClientRect().width) / zoom
          + Number.parseFloat(getComputedStyle(footer).columnGap)
          + Number.parseFloat(getComputedStyle(element.querySelector(".mission-list-actions")!).columnGap)
        return required + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) + 2
          + (compact ? Number.parseFloat(getComputedStyle(element.querySelector(".mission-list-text")!).minWidth) + Number.parseFloat(style.columnGap) : 0)
      }, { compact, zoom })
      for (const offset of [-1, -0.5, 0, 0.5, 1]) {
        const flips = await page.evaluate(async ({ width, row }) => {
          const element = document.querySelector(row)!
          let flips = 0
          const observer = new MutationObserver(records => { flips += records.length })
          observer.observe(element, { attributes: true, attributeFilter: ["class"] })
          ;(window as any).missionListFixture.width(width)
          await new Promise(resolve => setTimeout(resolve, 100))
          observer.disconnect()
          return flips
        }, { width: threshold + offset, row })
        assert.ok(flips <= 1, `${compact}/${zoom}/${offset}: ${flips} presentation flips`)
      }
    }
  } finally { await page.close() }
})

test("fresh keyed descriptors preserve focused inline buttons and use all latest fields/callbacks", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    await width(page, 520, false)
    const button = await page.locator(`${row} .mission-list-inline button`).nth(0).elementHandle()
    await button!.focus()
    await page.evaluate(() => {
      const fixture = (window as any).missionListFixture
      fixture.refresh(); fixture.reverse(); fixture.checked(true); fixture.disabled(true)
    })
    await page.waitForTimeout(100)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.match((await button!.getAttribute("aria-label"))!, / 1$/)
    assert.equal(await button!.getAttribute("aria-description"), "generation 1")
    const edit = page.locator(`${row} .mission-list-inline button[aria-label="Edit mission 1"]`)
    assert.equal(await edit.isDisabled(), true)
    assert.equal(await edit.getAttribute("aria-pressed"), "true")
    await button!.dispatchEvent("mouseenter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="hover"]')?.textContent === "coordinator:1:enter")
    await button!.dispatchEvent("mouseleave")
    await page.waitForFunction(() => document.querySelector('[data-fixture="hover"]')?.textContent === "coordinator:1:leave")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="selection"]')?.textContent === "coordinator:1")
    await page.evaluate(() => { (window as any).missionListFixture.omitRecovery(true); (window as any).missionListFixture.refresh() })
    await page.waitForTimeout(80)
    assert.equal(await page.locator(`${row} .mission-list-inline button`).count(), 3)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="selection"]')?.textContent === "coordinator:2")
  } finally { await page.close() }
})

test("open menus retain keyed focused items on refresh, use latest actions, and leave icons in both surfaces", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    await width(page, 170, true)
    const inline = await page.locator(`${row} .mission-list-inline button`).nth(0).elementHandle()
    await page.locator(trigger).click()
    const item = await page.getByRole("menuitem").nth(0).elementHandle()
    await item!.focus()
    await page.evaluate(() => { (window as any).missionListFixture.refresh(); (window as any).missionListFixture.reverse() })
    await page.waitForTimeout(100)
    assert.equal(await item!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.equal(await item!.getAttribute("aria-description"), "generation 1")
    assert.match((await item!.textContent())!, / 1$/)
    assert.equal(await page.locator(`${row} .mission-list-inline button svg`).count(), 4)
    assert.equal(await page.locator(".action-overflow-item svg").count(), 4)
    await page.evaluate(() => { (window as any).missionListFixture.checked(true); (window as any).missionListFixture.disabled(true) })
    const edit = page.getByRole("menuitemcheckbox", { name: "Edit mission 1" })
    assert.equal(await edit.getAttribute("aria-checked"), "true")
    assert.equal(await edit.getAttribute("aria-disabled"), "true")
    assert.equal(await item!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await item!.dispatchEvent("pointerenter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="hover"]')?.textContent === "coordinator:1:enter")
    await item!.dispatchEvent("pointerleave")
    await page.waitForFunction(() => document.querySelector('[data-fixture="hover"]')?.textContent === "coordinator:1:leave")
    // Refresh + resize must preserve the focused menu control, not merely reopen it.
    await page.evaluate(() => (window as any).missionListFixture.width(520))
    await page.waitForTimeout(80)
    assert.equal(await item!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="selection"]')?.textContent === "coordinator:1")
    await width(page, 520, false)
    assert.equal(await inline!.evaluate(e => e.isConnected && e.querySelectorAll("svg").length === 1), true)
    assert.equal(await page.locator(`${row} .mission-list-inline button svg`).count(), 4)
    await width(page, 170, true)
    await page.locator(trigger).click()
    assert.equal(await page.locator(".action-overflow-item svg").count(), 4)
    await page.keyboard.press("Escape")
    await width(page, 520, false)
    assert.equal(await page.locator(`${row} .mission-list-inline button svg`).count(), 4)
  } finally { await page.close() }
})
