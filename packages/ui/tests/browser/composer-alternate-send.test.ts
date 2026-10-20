import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("composer-alternate-send") })
after(async () => { await fixture?.close() })

const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name: new RegExp(`^${name}`) })
const openMenu = (page: Page) => page.getByRole("button", { name: "More actions", exact: true }).click()
const sends = (page: Page) => page.evaluate(() => (window as any).fixture.sends.map((send: any) => `${send.prompt}:${send.delivery}`))

test("the composer menu and Alt+Enter send with the other follow-up delivery while a session runs", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 900, height: 600 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
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
    assert.equal(await menuItem(page, "Steer now").isDisabled(), true)
    await page.keyboard.press("Escape")
    await page.evaluate(() => (window as any).fixture.setBusy(true))
    await input.fill("")
    await openMenu(page)
    assert.equal(await menuItem(page, "Steer now").isDisabled(), true)
    await page.keyboard.press("Escape")
    assert.equal((await sends(page)).length, 4)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
