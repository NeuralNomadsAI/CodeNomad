import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("composer-history-focus") })
after(async () => { await fixture?.close() })

test("history recall places the caret immediately and preserves a newer composer focus", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const first = page.locator("textarea").nth(0)
    const second = page.locator("textarea").nth(1)
    await first.focus()
    // Freeze timers after bootstrap: real keyboard and pointer events can
    // overtake a pending history callback on a busy renderer.
    const now = new Date()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    await first.press("ArrowUp")
    assert.equal(await first.inputValue(), "previous message")
    await second.click()
    await page.clock.runFor(1)
    await page.keyboard.type("new draft")
    assert.equal(await second.inputValue(), "new draft", "the selected composer retains all typing")
    assert.equal(await first.inputValue(), "previous message")

    await first.fill("")
    await first.press("ArrowDown")
    await first.press("ArrowUp")
    assert.equal(await first.evaluate(element => (element as HTMLTextAreaElement).selectionStart), "previous message".length,
      "recall updates the caret before another key can arrive")
    await page.keyboard.type("!")
    assert.equal(await first.inputValue(), "previous message!")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
