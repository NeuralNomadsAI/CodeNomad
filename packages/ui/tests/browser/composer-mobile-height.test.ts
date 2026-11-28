import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, devices, webkit, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser
let url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "composer-mobile-height", routes: [
    { path: "/fixture", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>' },
  ] })
  url = `${fixture.url}?keyboardViewport`
  events = await fixtureEventStream(url)
  browser = process.env.CODENOMAD_COMPOSER_WEBKIT === "1"
    ? await webkit.launch()
    : await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  try { await browser?.close() }
  finally { await events?.close() }
})

const field = "textarea.prompt-input"
const handle = ".prompt-resize-handle"
const stream = ".message-stream"
const heightKey = "opencode-session-prompt-input-height-v1"

async function setup(page: Page) {
  await page.addInitScript(`(() => {
    const viewport = window.visualViewport
    let loss = 0, top = 0, scale = 1
    Object.defineProperties(viewport, {
      height: { get: () => innerHeight - loss },
      offsetTop: { get: () => top },
      scale: { get: () => scale },
    })
    window.setVisual = (nextLoss, nextTop, nextScale) => {
      const resized = nextLoss !== loss || nextScale !== scale
      loss = nextLoss; top = nextTop; scale = nextScale
      viewport.dispatchEvent(new Event(resized ? "resize" : "scroll"))
    }
  })()`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/meta", route => route.fulfill({ json: { localRequest: false } }))
  await events.route(page)
  await page.goto(url, { timeout: 45_000 })
  await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 45_000 })
  await page.getByText("Fixture message", { exact: true }).waitFor()
}

async function geometry(page: Page) {
  return page.evaluate(({ field, stream, heightKey }) => {
    const area = document.querySelector<HTMLElement>("[data-keyboard-viewport]")!
    const center = area.querySelector("[data-session-center-width]")!.getBoundingClientRect()
    const textarea = document.querySelector<HTMLTextAreaElement>(field)!
    const button = area.querySelector<HTMLButtonElement>(".send-button")!
    const buttonRect = button.getBoundingClientRect()
    const messages = area.querySelector(stream)!
    const streamRect = messages.getBoundingClientRect()
    const message = messages.querySelector("[data-virtual-follow-key] .message-text")?.getBoundingClientRect()
    const visualTop = visualViewport!.offsetTop
    const visualBottom = visualTop + visualViewport!.height
    return {
      height: textarea.getBoundingClientRect().height, focused: document.activeElement === textarea,
      bottom: textarea.getBoundingClientRect().bottom, top: textarea.getBoundingClientRect().top,
      buttonBottom: buttonRect.bottom, buttonHit: button.contains(document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2)),
      scrollable: textarea.scrollHeight > textarea.clientHeight && getComputedStyle(textarea).overflowY === "auto",
      streamHeight: Math.max(0, Math.min(streamRect.bottom, visualBottom) - Math.max(streamRect.top, visualTop)),
      visibleMessageHeight: message ? Math.max(0, Math.min(message.bottom, streamRect.bottom, visualBottom) - Math.max(message.top, streamRect.top, visualTop)) : 0,
      inset: parseFloat(getComputedStyle(area).paddingBottom),
      center: center.height, centerTop: center.top, windowHeight: innerHeight,
      visualTop, visualBottom,
      ratio: (window as any).fixture.promptHeight(), persisted: (window as any).fixture.readLayout(heightKey),
    }
  }, { field, stream, heightKey })
}

async function settle(page: Page) {
  // Offset rAF → layout → ResizeObserver → measurement rAF.
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }))
  return geometry(page)
}

async function viewport(page: Page, loss: number, top = 0, scale = 1) {
  await page.evaluate(args => (window as any).setVisual(...args), [loss, top, scale])
  return settle(page)
}

async function dragHandle(page: Page, upward: number) {
  const rect = (await page.locator(handle).boundingBox())!
  const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2 + 1)
  if (browser.browserType().name() === "chromium") {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - upward }] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    } finally { await cdp.detach() }
  } else {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - upward, { steps: 4 })
    await page.mouse.up()
  }
}

function near(actual: number, expected: number, reason: string) {
  assert.ok(Math.abs(actual - expected) <= 1, `${reason}: expected ${expected} ±1, got ${actual}`)
}

function reachable(metrics: Awaited<ReturnType<typeof geometry>>, reserve = 64) {
  assert.ok(metrics.top >= metrics.visualTop - 1)
  assert.ok(metrics.bottom <= metrics.visualBottom + 1)
  assert.ok(metrics.buttonBottom <= metrics.visualBottom + 1)
  assert.ok(metrics.buttonHit, "the real Send button receives a hit")
  assert.ok(metrics.streamHeight >= reserve - 1, JSON.stringify(metrics))
}

for (const [label, profile] of [
  ["Android phone profile", devices["Pixel 5"]],
  ["iOS phone profile", devices["iPhone 13"]],
  ["iOS tablet profile", devices["iPad (gen 7)"]],
] as const) {
  test(`${label}: automatic and intermediate heights retain the keyboard-free reference`, async () => {
    const page = await browser.newPage({ ...profile, viewport: { width: profile.viewport.width, height: 1000 } })
    try {
      await setup(page)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.runtimeEnv), { host: "web", platform: "mobile", windowContext: "remote" })
      const textarea = page.locator(field)
      const start = await settle(page)
      assert.ok(start.height > 44, "exercise the ratio above its pixel floor")
      near(start.height, Math.floor(start.center * 0.08), "automatic height")
      await textarea.fill("Long draft kept while typing\n".repeat(20))
      const opened = await viewport(page, 320)
      near(opened.inset, 320, "real application padding")
      near(opened.height, start.height, "automatic height after open")
      assert.equal(opened.scrollable, true)
      reachable(opened)
      const panned = await viewport(page, 320, 96)
      near(panned.inset, 224, "inset accounts for pan exactly once")
      near(panned.height, start.height, "pan does not redefine keyboard-free height")
      reachable(panned)
      const closedWithFocus = await viewport(page, 0)
      assert.equal(closedWithFocus.focused, true)
      near(closedWithFocus.height, start.height, "automatic height restored without blur")
      near(closedWithFocus.inset, 0, "no reserved space after close")

      const grip = page.locator(handle)
      const rect = (await grip.boundingBox())!
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + 1)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 - 83, { steps: 4 })
      await page.mouse.up()
      const chosen = await settle(page)
      assert.ok(chosen.height > start.height && chosen.ratio?.ratio > 0.08 && chosen.ratio?.ratio < 0.6)
      assert.equal(chosen.persisted, `ratio:${chosen.ratio.ratio}`)
      const withKeyboard = await viewport(page, 320)
      near(withKeyboard.height, chosen.height, "pointer-selected height survives occlusion")
      assert.equal(withKeyboard.persisted, chosen.persisted)
      reachable(withKeyboard)
    } finally { await page.close() }
  })
}

test("Android Remote Control renderer: capped maximum, rotation, split screen and expanded request", async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 393, height: 851 } })
  try {
    await setup(page)
    const grip = page.locator(handle), textarea = page.locator(field)
    await grip.focus()
    await page.keyboard.press("End")
    await textarea.fill("The long draft stays editable\n".repeat(20))
    const original = await settle(page)
    assert.equal(original.persisted, "ratio:0.6", JSON.stringify(original))
    near(original.height, Math.floor(original.center * 0.6), "nominal maximum")
    const capped = await viewport(page, 350)
    assert.ok(capped.height < original.height)
    reachable(capped)
    assert.equal(capped.persisted, original.persisted)
    assert.equal(capped.scrollable, true)
    await page.evaluate(() => (window as any).fixture.setComposerAttachment(true))
    await page.getByText("fixture-height.txt", { exact: false }).first().waitFor()
    const withAttachment = await settle(page)
    assert.ok(withAttachment.height < capped.height, "a visible attachment row reduces the field budget")
    reachable(withAttachment)
    assert.equal(withAttachment.persisted, original.persisted)
    await page.evaluate(() => (window as any).fixture.setComposerAttachment(false))

    await page.setViewportSize({ width: 851, height: 393 })
    const landscape = await viewport(page, 160)
    assert.equal(landscape.windowHeight, 393)
    assert.ok(landscape.height < capped.height)
    reachable(landscape)
    assert.equal(landscape.persisted, original.persisted)
    const short = await viewport(page, 200)
    near(short.height, 44, "a short landscape keeps the one-line field")
    reachable(short, 1)
    assert.ok(short.streamHeight < 64, "the controls take priority once the reading reserve cannot fit")
    await viewport(page, 250)
    const send = page.locator(".send-button")
    await send.scrollIntoViewIfNeeded()
    const scrolled = await settle(page)
    assert.ok(scrolled.buttonBottom <= scrolled.visualBottom + 1 && scrolled.buttonHit,
      "even when the whole composer cannot fit, scrolling reaches Send")

    const landscapeClosed = await viewport(page, 0)
    assert.equal(landscapeClosed.focused, true)
    near(landscapeClosed.height, Math.floor(landscapeClosed.center * 0.6), "rebase on landscape height")
    await page.setViewportSize({ width: 530, height: 335 })
    const split = await settle(page)
    near(split.inset, 0, "genuine paired viewport resize is not a keyboard")
    near(split.height, Math.floor(split.center * 0.6), "split screen recomputes ratio")
    assert.equal(split.persisted, original.persisted)

    await page.setViewportSize({ width: 393, height: 851 })
    await page.evaluate(() => (window as any).fixture.nativeQuestion("session", "mobile-height-request"))
    const answer = page.locator('.interruption-dock input[type="text"]')
    await answer.fill("A response")
    const interrupted = await viewport(page, 350)
    near(interrupted.height, 44, "expanded request still compacts the composer")
    assert.equal(await grip.getAttribute("aria-disabled"), "true")
    assert.equal(interrupted.persisted, original.persisted)
    const submit = page.getByRole("button", { name: "Submit", exact: true })
    await submit.click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    const restored = await viewport(page, 0)
    near(restored.height, original.height, "restores the original maximum after settlement")
    assert.equal(restored.persisted, original.persisted)
    assert.equal(await textarea.inputValue(), "The long draft stays editable\n".repeat(20))
  } finally { await page.close() }
})

test("a keyboard pan of 150px leaves a message visible in the reserved transcript", async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 393, height: 851 } })
  try {
    await setup(page)
    await page.locator(field).fill("Draft")
    const opened = await viewport(page, 350)
    assert.ok(opened.visibleMessageHeight >= 16, JSON.stringify(opened))
    const panned = await viewport(page, 350, 150)
    reachable(panned)
    near(panned.height, opened.height, "pan keeps the automatic height")
    assert.ok(panned.visibleMessageHeight >= 16, JSON.stringify(panned))
    const closed = await viewport(page, 0)
    assert.equal(closed.focused, true)
    assert.ok(closed.visibleMessageHeight >= 16, JSON.stringify(closed))
    assert.equal(await page.locator(".session-view").evaluate(el => getComputedStyle(el).getPropertyValue("--keyboard-transcript-inset")), "")
  } finally { await page.close() }
})

test("dragging a capped field edits its chosen height, not the temporary height", async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 393, height: 851 } })
  try {
    await setup(page)
    await page.locator(handle).focus()
    await page.keyboard.press("End")
    await page.locator(field).fill("Draft")
    const original = await settle(page)
    near(original.height, 496, "saved maximum")
    const capped = await viewport(page, 350)
    near(capped.height, 319, "temporary visible height")
    await dragHandle(page, 12)
    const raised = await settle(page)
    assert.equal(raised.persisted, "ratio:0.6", "dragging up from the maximum must not reduce it")
    near(raised.height, capped.height, "dragging up stays capped")
    near((await viewport(page, 0)).height, original.height, "closing restores the maximum")

    await viewport(page, 350)
    await dragHandle(page, -12)
    const lowered = await settle(page)
    assert.equal(lowered.persisted, `ratio:${(original.height - 12) / original.center}`)
    near(lowered.height, capped.height, "the smaller preference is still capped")
    near((await viewport(page, 0)).height, original.height - 12, "closing applies the manual reduction")
  } finally { await page.close() }
})

test("browser chrome, pan and pinch zoom retain the ordinary visible reference, and desktop remains unchanged", async () => {
  for (const touch of [true, false]) {
    const page = await browser.newPage({ ...(touch ? devices["Pixel 5"] : {}), viewport: { width: touch ? 393 : 1100, height: 900 } })
    try {
      await setup(page)
      await page.locator(handle).focus()
      await page.keyboard.press("End")
      await page.locator(field).focus()
      const start = await settle(page)
      for (const [loss, top, scale] of touch ? [[55, 0, 1], [0, start.centerTop + 80, 1], [340, 120, 1.7]] : [[200, 0, 1]]) {
        const metrics = await viewport(page, loss, top, scale)
        const visible = Math.min(start.centerTop + start.center, metrics.visualBottom) - Math.max(start.centerTop, metrics.visualTop)
        near(metrics.inset, 0, "no keyboard reservation")
        near(metrics.height, Math.floor(visible * 0.6), "ordinary visible reference")
        assert.equal(metrics.persisted, start.persisted)
      }
    } finally { await page.close() }
  }
})

test("a legacy pixel height is migrated once and recovered after an occluding keyboard", async () => {
  const page = await browser.newPage({ ...devices["Pixel 5"], viewport: { width: 393, height: 851 } })
  try {
    await page.addInitScript(key => localStorage.setItem(key, "220"), heightKey)
    await setup(page)
    const initial = await settle(page)
    near(initial.height, 220, "legacy height")
    assert.equal(initial.persisted, `ratio:${220 / initial.center}`)
    await page.locator(field).focus()
    const clipped = await viewport(page, 580)
    assert.ok(clipped.height < initial.height)
    reachable(clipped)
    assert.equal(clipped.persisted, initial.persisted)
    const restored = await viewport(page, 0)
    near(restored.height, initial.height, "restored legacy choice")
    assert.equal(restored.persisted, initial.persisted)
  } finally { await page.close() }
})
