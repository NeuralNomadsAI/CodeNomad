import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "appearance",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\" style=\"height:100vh\"></div><script type=\"module\" src=\"/tests/browser/fixtures/appearance.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

function merge(target: any, patch: any): any {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value) ? merge(result[key] ?? {}, value) : value
  }
  return result
}

const keepAwakeTitle = "Keep the computer awake while CodeNomad is running"
const keepAwakeInfo = "Prevents system sleep while a local CodeNomad window is open (including minimized); the screen can still turn off. When off, CodeNomad keeps the computer awake only while a session is working."

test("General hides keep-awake in a plain web browser and remote desktop views", async () => {
  for (const host of ["web", "electron", "tauri"]) {
    const page = await browser.newPage({ locale: "en-US" })
    await page.addInitScript(({ host }) => Object.assign(window, {
      __CODENOMAD_RUNTIME_HOST__: host, __CODENOMAD_WINDOW_CONTEXT__: "remote",
    }), { host })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).appearanceFixture))
      await page.getByRole("checkbox", { name: "Automatically expand subsessions", exact: true }).waitFor()
      assert.equal(await page.getByRole("checkbox", { name: keepAwakeTitle, exact: true }).count(), 0, host)
    } finally { await page.close() }
  }
})

for (const host of ["electron", "tauri"]) for (const windowContext of ["local", "preferences"]) {
  test(`General persists keep-awake with an independent info tip in ${host} ${windowContext}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: "en-US" })
    await page.addInitScript({ content: `Object.assign(window, {
      __CODENOMAD_RUNTIME_HOST__: ${JSON.stringify(host)}, __CODENOMAD_WINDOW_CONTEXT__: ${JSON.stringify(windowContext)},
      open: () => null,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: ${JSON.stringify(windowContext)} }, currentWebview: { label: ${JSON.stringify(windowContext)} } },
        invoke: async () => undefined,
      },
    })` })
    let config: any = {}
    const patches: unknown[] = []
    await page.route("**/api/**", async route => {
      const request = route.request(), ui = new URL(request.url()).pathname === "/api/storage/config/ui"
      if (ui && request.method() === "PATCH") {
        patches.push(request.postDataJSON())
        config = merge(config, request.postDataJSON())
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(ui ? config : {}) })
    })
    const option = page.getByRole("checkbox", { name: keepAwakeTitle, exact: true })
    const row = page.locator(".settings-choice-row").filter({ has: option })
    const info = row.getByRole("link", { name: keepAwakeInfo, exact: true })
    const waitChecked = (checked: boolean) => page.waitForFunction(({ title, checked }) =>
      document.querySelector<HTMLInputElement>(`input[aria-label="${title}"]`)?.checked === checked,
    { title: keepAwakeTitle, checked })
    const toggle = async (checked: boolean) => {
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/api/storage/config/ui" && response.request().method() === "PATCH"),
        option.click(),
      ])
      await waitChecked(checked)
      assert.deepEqual(patches.at(-1), { settings: { keepComputerAwake: checked } })
    }
    try {
      await page.goto(url)
      await option.waitFor()
      assert.equal(await option.isChecked(), false)
      assert.equal(await row.innerText(), keepAwakeTitle, "only the title appears inline")
      assert.equal(await row.locator(".settings-toggle-caption").count(), 0)
      assert.equal(await page.getByRole("tooltip").count(), 0)
      assert.equal(await row.evaluate(element => element === element.parentElement?.lastElementChild), true, "last behavior row")
      await option.focus()
      await page.keyboard.press("Shift+Tab")
      assert.equal(await info.evaluate(element => document.activeElement === element), true)
      await page.getByRole("tooltip").waitFor()
      assert.equal(await page.getByRole("tooltip").innerText(), keepAwakeInfo)
      await info.click()
      assert.equal(await option.isChecked(), false)
      assert.deepEqual(patches, [], "info never writes the preference")
      await toggle(true)
      await page.reload()
      await waitChecked(true)
      await toggle(false)
      await page.reload()
      await option.waitFor()
      await waitChecked(false)
      assert.equal(config.settings.keepComputerAwake, false)
    } finally { await page.close() }
  })
}

async function open(run: (page: Page) => Promise<void>, saveDelay = 0) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: "en-US" })
  let state: any = {}
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().includes("/storage/state/ui") && request.method() === "PATCH") {
      if (saveDelay) await new Promise(resolve => setTimeout(resolve, saveDelay))
      state = merge(state, request.postDataJSON())
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(request.url().includes("/storage/state/ui") ? state : {}) })
  })
  try { await page.goto(url); await page.waitForFunction(() => Boolean((window as any).appearanceFixture)); await run(page) }
  finally { await page.close() }
}

// General offers the timeline-corner layout beside the timeline itself: off by
// default, saved through the ui config owner and restored after a reload.
test("General offers the first/latest arrows under the timeline, off by default and kept across reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: "en-US" })
  let config: any = {}
  await page.route("**/api/**", async route => {
    const request = route.request(), ui = request.url().includes("/storage/config/ui")
    if (ui && request.method() === "PATCH") config = merge(config, request.postDataJSON())
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(ui ? config : {}) })
  })
  const option = page.getByRole("checkbox", { name: "Put the first/latest message arrows under the timeline", exact: true })
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).appearanceFixture))
    assert.equal(await option.isChecked(), false)
    await Promise.all([
      page.waitForResponse(response => response.url().includes("/storage/config/ui") && response.request().method() === "PATCH"),
      option.click(),
    ])
    assert.equal(config.settings?.scrollControlsInTimelineCorner, true)
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).appearanceFixture))
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]:checked') !== null)
    assert.equal(await option.isChecked(), true)
  } finally { await page.close() }
})

test("mode filters a flat palette list and retains both choices across reload", async () => open(async page => {
  const picker = page.locator(".theme-scheme-picker")
  const mode = async (name: string) => {
    await page.locator(".theme-scheme-mode").getByRole("button", { name, exact: true }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.disabled)
  }
  await mode("Dark")
  await picker.selectOption("builtin:slate")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  assert.equal(await picker.locator('option[value="builtin:linen"]').count(), 0)
  assert.equal(await picker.locator('option[value="builtin:classic"]').textContent(), "Classic")
  assert.equal(await picker.locator("optgroup").count(), 0)
  await mode("Light")
  await picker.selectOption("builtin:linen")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
  assert.equal(await picker.locator('option[value="builtin:slate"]').count(), 0)
  await mode("Dark")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await mode("Auto")
  assert.equal(await page.locator(".theme-scheme-mode .theme-scheme-appearance-options").count(), 1)
  await page.emulateMedia({ colorScheme: "light" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.value === "builtin:linen")
  assert.equal(await picker.locator('option[value="builtin:slate"]').count(), 0)
  await page.emulateMedia({ colorScheme: "dark" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.value === "builtin:slate")
  assert.equal(await picker.locator('option[value="builtin:linen"]').count(), 0)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await mode("Light")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
}))

async function openContrast(run: (page: Page, server: { config: any; patches: any[]; fail: boolean; delay: number }) => Promise<void>, locale = "en-US", width = 1600) {
  const page = await browser.newPage({ viewport: { width, height: 1100 }, locale })
  const server = { config: {} as any, patches: [] as any[], fail: false, delay: 0 }
  let state: any = {}
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const ui = path === "/api/storage/config/ui", clientState = path === "/api/storage/state/ui"
    if (request.method() === "PATCH") {
      if (ui) {
        const patch = request.postDataJSON()
        server.patches.push(patch)
        if (server.delay) await new Promise(resolve => setTimeout(resolve, server.delay))
        if (server.fail) {
          await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' })
          return
        }
        server.config = merge(server.config, patch)
      } else if (clientState) state = merge(state, request.postDataJSON())
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(ui ? server.config : clientState ? state : {}) })
  })
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).appearanceFixture))
    await page.locator(".theme-scheme-contrast [role=group]").waitFor()
    await run(page, server)
  } finally { await page.close() }
}

async function expectContrast(page: Page, choice: string, effective: boolean) {
  await page.waitForFunction(({ choice, effective }) => {
    const group = document.querySelector(".theme-scheme-contrast [role=group]")
    return group?.getAttribute("aria-busy") === "false"
      && group.querySelector('[aria-pressed="true"]')?.textContent === choice
      && (document.documentElement.dataset.contrast === "more") === effective
  }, { choice, effective })
  assert.equal(await page.locator('.theme-scheme-contrast [aria-pressed="true"]').count(), 1)
}

test("contrast shares the Mode row and wraps without overflow in either text direction", async () => {
  for (const locale of ["en-US", "he"]) for (const width of [1600, 390]) {
    await openContrast(async page => {
      const row = page.locator(".theme-scheme-appearance-row")
      const { mode, contrast, bounds } = await row.evaluate(async element => {
        await document.fonts.ready
        let previous = "", stable = 0
        for (let frame = 0; frame < 60; frame++) {
          await new Promise(requestAnimationFrame)
          const boxes = {
            mode: element.querySelector(".theme-scheme-mode")!.getBoundingClientRect().toJSON(),
            contrast: element.querySelector(".theme-scheme-contrast")!.getBoundingClientRect().toJSON(),
            bounds: element.getBoundingClientRect().toJSON(),
          }
          const current = JSON.stringify(boxes)
          stable = current === previous ? stable + 1 : 0
          if (stable === 2) return boxes
          previous = current
        }
        throw new Error("Appearance row layout did not stabilize")
      })
      assert.ok(mode && contrast && bounds)
      if (width === 1600) {
        assert.ok(Math.abs(mode.y - contrast.y) < 2, `${locale}: same row`)
        assert.ok(locale === "he" ? contrast.x < mode.x : contrast.x > mode.x, `${locale}: contrast at inline end`)
      } else {
        assert.ok(contrast.y >= mode.y + mode.height, `${locale}: wraps as a group`)
      }
      for (const box of [mode, contrast]) {
        assert.ok(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1, JSON.stringify(box))
      }
      assert.equal(await row.locator(".theme-scheme-contrast .settings-info-tip").count(), 1)
    }, locale, width)
  }
})

test("contrast covers all three choices, system changes, explicit Auto and reload without automatic writes", async () => openContrast(async (page, server) => {
  const group = page.getByRole("group", { name: "Contrast", exact: true })
  const info = page.locator(".theme-scheme-contrast .settings-info-tip")
  for (const system of ["no-preference", "more"] as const) {
    await page.emulateMedia({ contrast: system })
    await expectContrast(page, "Auto", system === "more")
    assert.match(await info.getAttribute("aria-label") ?? "", system === "more" ? /currently on/ : /currently off/)
  }
  assert.deepEqual(server.patches, [], "initial read and system changes never persist")
  for (const [choice, stored] of [["On", "on"], ["Off", "off"]] as const) {
    await group.getByRole("button", { name: choice, exact: true }).click()
    await expectContrast(page, choice, stored === "on")
    assert.deepEqual(server.patches.at(-1), { settings: { highContrast: stored } })
    const count = server.patches.length
    for (const system of ["no-preference", "more"] as const) {
      await page.emulateMedia({ contrast: system })
      await expectContrast(page, choice, stored === "on")
    }
    assert.equal(server.patches.length, count, "manual choice overrides the system without writes")
    await page.reload()
    await expectContrast(page, choice, stored === "on")
    await group.getByRole("button", { name: "Auto", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expectContrast(page, "Auto", true)
    assert.deepEqual(server.patches.at(-1), { settings: { highContrast: "auto" } })
    await page.reload()
    await expectContrast(page, "Auto", true)
  }
  const count = server.patches.length
  await info.focus()
  await page.getByRole("tooltip").waitFor()
  await page.emulateMedia({ contrast: "no-preference" })
  await expectContrast(page, "Auto", false)
  assert.match(await page.getByRole("tooltip").innerText(), /currently off/)
  assert.equal(server.patches.length, count)
}))

test("contrast keeps composer and unsaved colors, applies immediately and reconciles a failed write without stealing focus", async () => openContrast(async (page, server) => {
  await page.locator(".theme-scheme-mode").getByRole("button", { name: "Light", exact: true }).click()
  const picker = page.locator(".theme-scheme-picker")
  await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.disabled)
  await picker.selectOption("builtin:parchment")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "parchment")
  const before = await page.evaluate(() => ({
    palette: document.documentElement.dataset.colorScheme,
    surface: getComputedStyle(document.documentElement).getPropertyValue("--surface-base"),
    text: getComputedStyle(document.documentElement).getPropertyValue("--text-muted"),
  }))
  await page.getByRole("textbox", { name: "Fixture composer" }).fill("Keep this draft")
  await page.locator('.theme-scheme-swatches input[type="color"]').first().fill("#123456")
  const save = page.getByRole("button", { name: "Save", exact: true })
  await save.waitFor()
  server.delay = 500
  const on = page.getByRole("group", { name: "Contrast", exact: true }).getByRole("button", { name: "On", exact: true })
  await on.focus()
  await page.keyboard.press("Space")
  await page.waitForFunction(() => document.documentElement.dataset.contrast === "more")
  assert.equal(await on.evaluate(element => document.activeElement === element), true)
  assert.equal(await picker.isDisabled(), false, "contrast write does not lock colors")
  assert.equal(await save.isEnabled(), true)
  await expectContrast(page, "On", true)
  assert.equal(await page.getByRole("dialog").count(), 0, "no discard confirmation")
  assert.equal(await page.getByRole("textbox", { name: "Fixture composer" }).inputValue(), "Keep this draft")
  assert.equal(await page.locator('.theme-scheme-swatches input[type="color"]').first().inputValue(), "#123456")
  assert.equal(await picker.inputValue(), "builtin:parchment")
  const off = page.getByRole("group", { name: "Contrast", exact: true }).getByRole("button", { name: "Off", exact: true })
  await off.click()
  await expectContrast(page, "Off", false)
  assert.deepEqual(await page.evaluate(() => ({
    palette: document.documentElement.dataset.colorScheme,
    surface: getComputedStyle(document.documentElement).getPropertyValue("--surface-base"),
    text: getComputedStyle(document.documentElement).getPropertyValue("--text-muted"),
  })), before, "Off restores exact normal rendering without saving colors")
  server.fail = true
  await on.focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.documentElement.dataset.contrast === "more")
  await page.getByRole("alert").filter({ hasText: "Couldn't save contrast. Try again." }).waitFor()
  await expectContrast(page, "Off", false)
  assert.equal(await on.evaluate(element => document.activeElement === element), true)
  assert.equal(await save.isEnabled(), true)
  assert.equal(await page.locator('.theme-scheme-swatches input[type="color"]').first().inputValue(), "#123456")
  server.fail = false
  await page.keyboard.press("Enter")
  await expectContrast(page, "On", true)
  assert.equal(await page.getByRole("alert").filter({ hasText: "Couldn't save contrast. Try again." }).count(), 0)
}))

test("contrast remains keyboard-accessible and unclipped on a Hebrew phone", async () => openContrast(async (page, server) => {
  const group = page.getByRole("group", { name: "ניגודיות", exact: true })
  await group.waitFor()
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl")
  assert.equal(await group.getAttribute("aria-label"), "ניגודיות")
  const buttons = group.getByRole("button")
  assert.deepEqual(await buttons.allTextContents(), ["אוטומטי", "מופעל", "כבוי"])
  await buttons.nth(0).focus()
  await page.keyboard.press("Tab")
  assert.equal(await buttons.nth(1).evaluate(element => document.activeElement === element), true)
  await page.keyboard.press("Enter")
  await expectContrast(page, "מופעל", true)
  assert.equal(server.config.settings.highContrast, "on")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Space")
  await expectContrast(page, "כבוי", false)
  const info = page.locator(".theme-scheme-contrast .settings-info-tip")
  await info.focus()
  await page.getByRole("tooltip").waitFor()
  for (const element of [group, info, ...await buttons.all()]) {
    const box = await element.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box))
  }
  assert.ok(await page.getByRole("tooltip").innerText())
}, "he", 390))

test("palette arrow navigation retains focus and saves the latest choice during slow writes", async () => open(async page => {
  const picker = page.locator(".theme-scheme-picker")
  await page.locator(".theme-scheme-mode").getByRole("button", { name: "Dark", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.disabled)
  await picker.selectOption("builtin:classic")
  await page.waitForFunction(() => document.querySelector(".theme-scheme-picker")?.getAttribute("aria-busy") === "false")
  const options = await picker.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
  await picker.focus()
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => document.querySelector(".theme-scheme-picker")?.getAttribute("aria-busy") === "true")
  assert.equal(await picker.evaluate(element => document.activeElement === element), true)
  assert.equal(await picker.isDisabled(), false)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  assert.equal(await picker.inputValue(), options[3])
  await page.waitForFunction(id => document.documentElement.dataset.colorScheme === id, options[3].slice("builtin:".length))
  await page.waitForFunction(() => document.querySelector(".theme-scheme-picker")?.getAttribute("aria-busy") === "false")
  assert.equal(await picker.evaluate(element => document.activeElement === element), true)
  await page.keyboard.press("ArrowUp")
  await page.waitForFunction(id => document.documentElement.dataset.colorScheme === id, options[2].slice("builtin:".length))
  await page.waitForFunction(() => document.querySelector(".theme-scheme-picker")?.getAttribute("aria-busy") === "false")
  assert.equal(await picker.evaluate(element => document.activeElement === element), true)
  await page.reload()
  await page.waitForFunction(id => document.documentElement.dataset.colorScheme === id, options[2].slice("builtin:".length))
  assert.equal(await picker.inputValue(), options[2])
}, 350))

test("Classic and soft palettes preserve local subtle hover on messages, sessions and panels", async () => open(async page => {
  const ids = ["classic", "mist", "slate", "clay", "sage", "porcelain", "dawn", "parchment", "linen", "iris", "sage-light", "light", "basalt", "fjord", "lichen", "velvet", "ember"]
  const targets = [".tool-call-header", ".session-item-inactive", ".session-item-active", ".file-list-item", ".file-list-item-active", ".file-viewer-toolbar-icon-button", ".git-change-section-header", ".status-process-command", ".right-panel-accordion-header-row", '.settings-nav-button[data-selected="true"]', ".right-panel-tab-active", ".right-panel-tab-inactive"]
  const output = process.env.CODENOMAD_PALETTE_SCREENSHOTS
  if (output) await mkdir(output, { recursive: true })
  for (const id of ids) {
    await page.evaluate(id => (window as any).appearanceFixture.apply(id), id)
    await page.mouse.move(1599, 1099)
    await page.waitForTimeout(220)
    const surfaces = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return Object.fromEntries(["--surface-base", "--surface-secondary", "--surface-inset", "--surface-code", "--message-assistant-bg", "--message-tool-bg"].map(k => [k, css.getPropertyValue(k)]))
    })
    // Output blocks follow the inset role; Classic Light keeps its V1 code surface.
    assert.equal(surfaces["--surface-code"], id === "light" ? "#F1F5F9" : surfaces["--surface-inset"], id)
    assert.equal(surfaces["--message-tool-bg"], surfaces["--message-assistant-bg"], id)
    assert.notEqual(surfaces["--message-tool-bg"], surfaces["--surface-secondary"], id)
    assert.equal(await page.locator(".settings-screen-content").evaluate(e => getComputedStyle(e).backgroundColor), await page.locator(".session-sidebar").evaluate(e => getComputedStyle(e).backgroundColor), id)
    for (const selector of targets) {
      const element = page.locator(selector).first()
      await page.mouse.move(1599, 1099); await page.waitForTimeout(220)
      const idle = await element.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).backgroundImage])
      await element.hover(); await page.waitForTimeout(220)
      const hovered = await element.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).backgroundImage])
      assert.notDeepEqual(hovered, idle, `${id} ${selector}: hover must remain visible`)
      if (selector === ".session-item-active" || selector === ".file-list-item-active" || selector.includes("data-selected") || selector.startsWith(".right-panel-tab")) {
        assert.equal(hovered[0], idle[0], `${id} ${selector}: keep the original selected/tab surface`)
      }
      // Each row uses the same translucent 4% layer on its own resting surface,
      // including selected rows (whose selection color must not disappear).
      assert.match(hovered.join(" "), /0\.04/, `${id} ${selector}: local 4% overlay`)
    }
    if (output) await page.screenshot({ path: `${output}/${id}.png` })
  }
}))
