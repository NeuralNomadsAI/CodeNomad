import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { fixtureEventStream } from "./fixture-event-stream"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
let events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  fixture = await startProductFixture("composer-alternate-send")
  events = await fixtureEventStream(fixture.url)
})
after(async () => {
  try { await fixture?.close() }
  finally { await events?.close() }
})

async function setup(page: Page) {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("response", response => { if (!response.ok()) errors.push(`${response.status()} ${response.url()}`) })
  page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
  try {
    const [stream] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/events", { timeout: 60_000 }),
      page.goto(fixture.url, { waitUntil: "domcontentloaded" }).then(() =>
        page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 60_000 })),
    ])
    assert.match(stream.headers()["content-type"], /text\/event-stream/)
  } catch (error) {
    throw new Error(`Composer fixture failed: ${errors.join("; ")}`, { cause: error })
  }
}

const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name: new RegExp(`^${name}`) })
const openMenu = (page: Page) => page.getByRole("button", { name: "More actions", exact: true }).click()
const sends = (page: Page) => page.evaluate(() => (window as any).fixture.sends.map((send: any) => `${send.prompt}:${send.delivery}`))
const waitDisabledSteer = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')]
  .some(item => item.textContent?.trim().startsWith("Steer now") && item.getAttribute("aria-disabled") === "true"))

test("the composer menu and Alt+Enter send with the other follow-up delivery while a session runs", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 900, height: 600 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await setup(page)
    const input = page.locator("textarea").first()

    // Enter steers: the menu offers queueing, with its shortcut.
    await input.fill("first")
    await openMenu(page)
    const queue = menuItem(page, "Queue message")
    assert.equal(await queue.isDisabled(), false)
    assert.equal(await queue.getAttribute("title"), "Alt+Enter / Ctrl+Shift+Enter", "the shortcuts are the item's tooltip, Alt+Enter first")
    await queue.click()
    await page.waitForFunction(() => (window as any).fixture.sends.length === 1)
    await input.fill("second")
    await input.press("Alt+Enter")
    await page.waitForFunction(() => (window as any).fixture.sends.length === 2)
    await input.fill("third")
    await input.press("Control+Shift+Enter")
    await page.waitForFunction(() => (window as any).fixture.sends.length === 3)
    assert.deepEqual(await sends(page), ["first:queue", "second:queue", "third:queue"])

    // Enter queues: the menu steers now instead.
    await page.evaluate(() => (window as any).fixture.setPreferences({ followUpBehavior: "queue" }))
    await input.fill("fourth")
    await openMenu(page)
    await menuItem(page, "Steer now").click()
    await page.waitForFunction(() => (window as any).fixture.sends.length === 4)
    assert.equal((await sends(page)).at(-1), "fourth:steer")

    // Nothing to choose while the session is idle or the draft is empty.
    await page.evaluate(() => (window as any).fixture.setBusy(false))
    await input.fill("fifth")
    await openMenu(page)
    await waitDisabledSteer(page)
    assert.equal(await menuItem(page, "Steer now").isDisabled(), true)
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "More actions")
    await page.evaluate(() => (window as any).fixture.setBusy(true))
    await input.fill("")
    await openMenu(page)
    await waitDisabledSteer(page)
    assert.equal(await menuItem(page, "Steer now").isDisabled(), true)
    await page.keyboard.press("Escape")
    assert.equal((await sends(page)).length, 4)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the prompt menu disables transcript navigation when its session is absent", async () => {
  const page = await fixture.browser.newPage()
  try {
    await setup(page)
    await page.locator("textarea").first().fill("Keep the draft")
    await page.evaluate(async () => {
      const { setSessions } = await import("/src/stores/session-state.ts" as string)
      setSessions(new Map())
    })
    await openMenu(page)
    assert.equal(await menuItem(page, "Previous User Message").isDisabled(), true)
    assert.equal(await menuItem(page, "Next User Message").isDisabled(), true)
    await page.keyboard.press("Escape")
    assert.equal(await page.locator("textarea").first().inputValue(), "Keep the draft")
    assert.deepEqual(await sends(page), [])
  } finally { await page.close() }
})

test("composer updates keep unchanged menu icons mounted and still switch the alternate icon", async () => {
  const page = await fixture.browser.newPage()
  try {
    await setup(page)
    await page.locator("textarea").first().fill("Draft")
    await openMenu(page)
    await menuItem(page, "Queue message").waitFor()
    const observed = await page.evaluate(() => {
      const fixture = (window as any).fixture
      const keys = ["alternate-send", "voice", "conversation", "attach", "user-message-prev", "user-message-next", "clear"]
      const rows = keys.map(key => document.querySelector(`[data-action-key="${key}"]`)!)
      const original = rows.map(row => row.querySelector("svg"))
      fixture.setBusy(false)
      return {
        disabled: rows[0].getAttribute("aria-disabled"),
        retained: keys.filter((_, i) => original[i] !== null && rows[i].querySelector("svg") === original[i]),
        distinct: new Set(original).size,
      }
    })
    assert.deepEqual(observed, {
      disabled: "true",
      retained: ["alternate-send", "voice", "conversation", "attach", "user-message-prev", "user-message-next", "clear"],
      distinct: 7,
    })
    await page.evaluate(() => (window as any).fixture.setPreferences({ followUpBehavior: "queue" }))
    await menuItem(page, "Steer now").locator("svg.lucide-send-horizontal").waitFor()
  } finally { await page.close() }
})
