import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { BUILT_IN_COLOR_SCHEMES, normalizeColorScheme } from "../../src/lib/theme-scheme"
import { highContrastColors } from "../../src/lib/high-contrast"
import { sampleContrast } from "./contrast-sampling"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "high-contrast", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/high-contrast.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function open() {
  const page = await browser.newPage()
  const buckets: Record<string, any> = {}
  const merge = (target: any, patch: any): any => Object.fromEntries(Object.entries({ ...target, ...patch })
    .filter(([key]) => patch[key] !== null)
    .map(([key, value]) => [key, patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key])
      ? merge(target?.[key] ?? {}, patch[key]) : value]))
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === "PATCH") buckets[path] = merge(buckets[path] ?? {}, request.postDataJSON())
    return route.fulfill({ json: buckets[path] ?? {} })
  })
  await page.addInitScript("window.__name = f => f")
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).contrastFixture))
  await page.waitForFunction(() => (window as any).contrastFixture.loaded())
  await page.addStyleTag({ content: "* { transition: none !important; animation: none !important; }" })
  return page
}
const apply = (page: Page, id: string, more: boolean) =>
  page.evaluate(({ id, more }) => (window as any).contrastFixture.apply(id, more), { id, more })
const schemes = BUILT_IN_COLOR_SCHEMES.filter(s => s.id !== "system" && s.id !== "custom")
const contrast = (page: Page, choice: "auto" | "on" | "off") =>
  page.evaluate(choice => (window as any).contrastFixture.contrast(choice), choice)
const frame = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const normalSnapshot = (page: Page) => page.evaluate(() => {
  const root = document.documentElement
  return {
    tokens: Array.from(root.style).filter(key => key.startsWith("--")).sort().map(key => [key, root.style.getPropertyValue(key)]),
    palette: root.dataset.colorScheme, appearance: root.dataset.theme,
    components: Array.from(document.querySelectorAll("#field, #composer, #mui-disabled, #muted-text, #disabled-action, .settings-info-tip"),
      el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.opacity, s.borderColor, s.outline, s.outlineOffset] }),
  }
})

test("rendering palette catalog has 17 unique fixed-appearance palettes", () => {
  assert.equal(schemes.length, 17)
  assert.equal(new Set(schemes.map(s => s.id)).size, schemes.length)
  for (const scheme of schemes) {
    assert.ok(scheme.colors, `${scheme.id}: rendering colors`)
    assert.ok(["dark", "light"].includes(scheme.appearance), `${scheme.id}: declared appearance`)
  }
})

test("sampler composites translucent backgrounds inside ancestor opacity groups", async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      document.body.style.background = "white"
      const host = document.createElement("div")
      host.id = "sample-group"
      host.style.cssText = "background: white; opacity: .5"
      host.innerHTML = '<span id="sample-ink" style="color: black; background: rgba(255,0,0,.5); opacity: .5">Ink</span>'
      document.body.append(host)
    })
    const value = await sampleContrast(page.locator("#sample-ink"))
    assert.equal(value.opacity, .25)
    // White page → 50% white group → 50% half-red child → black ink at 25%.
    for (const [actual, expected] of [[value.fill, [255, 223, 223]], [value.foreground, [191, 191, 191]]] as const) {
      assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 2), `${actual} vs ${expected}`)
    }
    assert.ok(value.ratio < 2)
  } finally { await page.close() }
})

test("high contrast keeps composed component text and icons readable on all 17 palettes", { timeout: 240000 }, async (t) => {
  const page = await open()
  const failures: string[] = []
  try {
    for (const scheme of schemes) {
      const dimmed = ["#disabled-action", ".right-panel-empty-text", ".git-panel-count", ".git-panel-file small",
        "#nested-disabled", ".context-meter-label"]
      await apply(page, scheme.id, false)
      const normalDimmed = new Map<string, Awaited<ReturnType<typeof sampleContrast>>>()
      for (const selector of dimmed) normalDimmed.set(selector, await sampleContrast(page.locator(selector).first()))
      await apply(page, scheme.id, true)
      await page.mouse.move(1, 1)
      for (const selector of ["#secondary-text", "#muted-text", "#accent-text", "#disabled-field",
        "#mui-disabled", "#search-match", "#search-active"]) {
        const value = await sampleContrast(page.locator(selector).first())
        if (value.ratio < 7) failures.push(`${scheme.id}/${selector}/rest text ${value.ratio.toFixed(2)} on ${value.fill} opacity ${value.opacity}`)
      }
      for (const selector of dimmed) {
        const value = await sampleContrast(page.locator(selector).first()), normal = normalDimmed.get(selector)!
        assert.ok(value.opacity > normal.opacity && value.opacity < 1, `${scheme.id}/${selector}: dimmed hierarchy`)
        assert.ok(value.ratio > normal.ratio, `${scheme.id}/${selector}: composed contrast improves (${normal.ratio.toFixed(2)} → ${value.ratio.toFixed(2)})`)
      }
      for (const selector of ["#field", "#composer"]) {
        const value = await sampleContrast(page.locator(selector), { pseudo: "::placeholder" })
        if (value.ratio < 7) failures.push(`${scheme.id}/${selector}/placeholder ${value.ratio.toFixed(2)} on ${value.fill}`)
      }
      for (const selector of [".settings-info-tip", "#tool-disabled", "#search-disabled"]) {
        const value = await sampleContrast(page.locator(selector).first(), { property: selector.includes("path") ? "stroke" : "color" })
        if (value.ratio < 3) failures.push(`${scheme.id}/${selector}/icon ${value.ratio.toFixed(2)} on ${value.fill} opacity ${value.opacity}`)
      }
      const opacities: Record<string, number> = { ".settings-info-tip": .88, "#tool-disabled": .78,
        "#search-disabled": .7, "#rail": .45, ".mission-graph path": .6, ".git-panel-count": .85,
        "#nested-disabled": .85, ".right-panel-empty-text": .78 * .78, ".context-meter-label": .72 }
      for (const [selector, expected] of Object.entries(opacities)) {
        const value = await sampleContrast(page.locator(selector).first(), { property: selector.includes("path") ? "stroke" : "color" })
        assert.equal(value.opacity, expected, `${scheme.id}/${selector}: opacity ladder`)
        assert.ok(value.ratio > 1, `${scheme.id}/${selector}: visible secondary indicator`)
      }
      const field = await sampleContrast(page.locator("#field"), { property: "border-top-color" })
      if (field.ratio < 3) failures.push(`${scheme.id}/field/border ${field.ratio.toFixed(2)}`)
      await page.locator("#secondary").focus()
      const focused = await sampleContrast(page.locator("#secondary"))
      if (focused.ratio < 7) failures.push(`${scheme.id}/secondary/focused text ${focused.ratio.toFixed(2)}`)
      await page.locator("#secondary").blur()
      await page.locator("#secondary").hover()
      const hover = await sampleContrast(page.locator("#secondary"))
      if (hover.ratio < 7) failures.push(`${scheme.id}/secondary/hover ${hover.ratio.toFixed(2)}`)
      for (const pseudo of ["::selection", "::highlight(codenomad-search)", "::highlight(codenomad-search-active)"]) {
        const value = await sampleContrast(page.locator("#native-selection"), { pseudo })
        if (value.ratio < 7) failures.push(`${scheme.id}/${pseudo}/selected text ${value.ratio.toFixed(2)}`)
      }
      await page.mouse.move(1, 1)
      for (const selector of ["#hidden-zero", "#hidden-inline", "#hidden-copy", "#hidden-technical", "#hidden-delete", "#hidden-stage", ".message-item-actions"]) {
        assert.equal((await sampleContrast(page.locator(selector))).opacity, 0, `${scheme.id}/${selector} stays hidden`)
      }
      assert.equal(await page.locator("#ansi-hidden").evaluate(el => getComputedStyle(el).visibility), "hidden")
      t.diagnostic(`${scheme.id}: text, placeholders, icons, borders, hover, selection and hidden states sampled`)
    }
    assert.deepEqual(failures, [])
  } finally { await page.close() }
})

test("turning contrast off restores component opacity and search styles exactly", async () => {
  const page = await open()
  try {
    const snapshot = async () => {
      await page.locator(".settings-info-tip").focus()
      return page.locator(".settings-info-tip, #disabled-action, #search-match, .right-panel-empty-text").evaluateAll(elements =>
        elements.map(el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.opacity, s.outline, s.outlineOffset] }))
    }
    await apply(page, "parchment", false)
    const before = await snapshot()
    await apply(page, "parchment", true)
    assert.notDeepEqual(await snapshot(), before)
    await apply(page, "parchment", false)
    assert.deepEqual(await snapshot(), before)
  } finally { await page.close() }
})

test("all rendering palettes restore every normal token and component style exactly", { timeout: 120000 }, async () => {
  const page = await open()
  try {
    for (const scheme of schemes) {
      await apply(page, scheme.id, false)
      const before = await normalSnapshot(page)
      await apply(page, scheme.id, true)
      assert.notDeepEqual(await normalSnapshot(page), before, scheme.id)
      await apply(page, scheme.id, false)
      assert.deepEqual(await normalSnapshot(page), before, scheme.id)
      assert.equal(await page.locator("html").getAttribute("data-contrast"), null, scheme.id)
    }
  } finally { await page.close() }
})

test("Auto appearance and contrast remain independent and restore their exact normal rendering", async () => {
  const page = await open()
  try {
    await page.evaluate(async () => {
      const f = (window as any).contrastFixture
      await f.palette("parchment")
      await f.palette("clay")
      await f.mode("system")
    })
    await contrast(page, "auto")
    const saved = await page.evaluate(() => (window as any).contrastFixture.saved())
    for (const colorScheme of ["light", "dark", "light"] as const) {
      await page.emulateMedia({ colorScheme, contrast: "no-preference" })
      const id = colorScheme === "light" ? "parchment" : "clay"
      await page.waitForFunction(id => document.documentElement.dataset.colorScheme === id
        && !document.documentElement.dataset.contrast, id)
      const before = await normalSnapshot(page)
      await page.emulateMedia({ contrast: "more" })
      await page.waitForFunction(() => document.documentElement.dataset.contrast === "more")
      assert.equal(await page.locator("html").getAttribute("data-color-scheme"), id)
      const value = await sampleContrast(page.locator("#secondary-text"))
      assert.ok(value.ratio >= 7, `${id}/auto/system text ${value.ratio} on ${value.fill}`)
      await page.emulateMedia({ contrast: "no-preference" })
      await page.waitForFunction(() => !document.documentElement.dataset.contrast)
      assert.deepEqual(await normalSnapshot(page), before, `${id}: Auto returns to normal`)
      await contrast(page, "on")
      await frame(page)
      assert.equal(await page.locator("html").getAttribute("data-contrast"), "more")
      await contrast(page, "off")
      await page.emulateMedia({ contrast: "more" })
      await frame(page)
      assert.deepEqual(await normalSnapshot(page), before, `${id}: explicit Off overrides system`)
      await page.emulateMedia({ contrast: "no-preference" })
      await contrast(page, "auto")
    }
    assert.deepEqual(await page.evaluate(() => (window as any).contrastFixture.saved()), saved)
  } finally { await page.close() }
})

test("Custom, named palettes and embedded overrides preserve saved extremes and restore exact normal styles", { timeout: 180000 }, async t => {
  const page = await open()
  try {
    for (const family of ["custom", "named", "override"]) for (const appearance of ["light", "dark"] as const) {
      for (const surface of ["#FFFFFF", "#000000", "#777777"]) {
        await contrast(page, "off")
        const colors = { ...normalizeColorScheme("custom").colors!,
          surfaceBase: surface, surfaceSecondary: surface, surfaceMuted: surface }
        await page.evaluate(async ({ family, appearance, colors }) =>
          (window as any).contrastFixture.customize(family, appearance, colors), { family, appearance, colors })
        const saved = await page.evaluate(() => (window as any).contrastFixture.saved())
        const before = await normalSnapshot(page)
        await contrast(page, "on")
        const inputs = highContrastColors(colors, appearance === "dark")
        const actual = await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement)
          return ["--surface-base", "--surface-secondary", "--surface-muted"].map(key => css.getPropertyValue(key).trim())
        })
        assert.deepEqual(actual, [inputs.surfaceBase, inputs.surfaceSecondary, surface], `${family}/${appearance}/${surface}: shared input rule`)
        assert.deepEqual(await page.evaluate(() => (window as any).contrastFixture.saved()), saved, `${family}: saved colors untouched`)
        const value = await sampleContrast(page.locator("#secondary-text"))
        // Intermediate/opposing custom surfaces retain their source input rule.
        // Report the actual result explicitly rather than certifying an unattainable floor.
        t.diagnostic(`${family}/${appearance}/${surface}/secondary/rest: ${value.ratio.toFixed(2)}:1 on ${value.fill}; ${value.ratio >= 7 ? "7:1 met" : "7:1 NOT MET"}`)
        assert.ok(Number.isFinite(value.ratio) && value.ratio > 1, `${family}: visible adapted text`)
        await contrast(page, "off")
        assert.deepEqual(await normalSnapshot(page), before, `${family}/${appearance}/${surface}: exact normal restoration`)
      }
    }
  } finally { await page.close() }
})

test("loaded Markdown transcript and appended messages never recalculate palette per message", { timeout: 120000 }, async t => {
  const page = await open()
  try {
    await page.evaluate(() => (window as any).contrastFixture.palette("parchment"))
    await contrast(page, "off")
    const revision = () => page.evaluate(() => (window as any).contrastFixture.revision())
    const initial = await revision()
    await page.evaluate(() => (window as any).contrastFixture.append(200))
    await page.waitForFunction(() => document.querySelectorAll("#loaded-transcript strong").length === 200)
    assert.equal(await revision(), initial, "mounting 200 Markdown messages never recalculates palette")
    await page.locator("#composer").fill("Unsent draft")
    await page.evaluate(() => {
      const transcript = document.getElementById("loaded-transcript")!
      ;(window as any).retainedMessages = Array.from(transcript.children)
    })
    for (let i = 0; i < 6; i++) {
      const before = await revision()
      const started = performance.now()
      await contrast(page, i % 2 === 0 ? "on" : "off")
      await frame(page)
      assert.equal(await revision(), before + 1, "one theme revision per effective toggle, independent of 200 messages")
      assert.equal(await page.evaluate(() => (window as any).retainedMessages.every((node: Element, i: number) =>
        document.getElementById("loaded-transcript")!.children[i] === node)), true, "message containers retained")
      assert.equal(await page.locator("#composer").inputValue(), "Unsent draft")
      t.diagnostic(`loaded transcript toggle ${i}: ${(performance.now() - started).toFixed(0)}ms including persistence and two frames`)
    }
    const beforeAppend = await revision()
    await page.evaluate(() => (window as any).contrastFixture.append(100))
    await page.waitForFunction(() => document.querySelectorAll("#loaded-transcript strong").length === 300)
    assert.equal(await revision(), beforeAppend, "appending 100 messages never recalculates palette")
  } finally { await page.close() }
})
