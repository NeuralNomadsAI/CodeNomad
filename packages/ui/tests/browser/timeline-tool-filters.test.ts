import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("timeline-tool-filters") })
after(async () => { await fixture?.close() })

test("timeline tool markers follow the tool types hidden in Message content", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 400, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const markers = () => page.evaluate(() => (window as any).fixture.markers())
    const settle = (expected: string[]) => page.waitForFunction(value => JSON.stringify((window as any).fixture.markers()) === value, JSON.stringify(expected))
    assert.deepEqual(await markers(), ["message-0", "message-1", "message-2", "message-3", "message-3"])

    await page.evaluate(() => (window as any).fixture.setTool("read", "hidden"))
    await settle(["message-0", "message-1", "message-3", "message-3"])
    // Unregistered tools follow "Other".
    await page.evaluate(() => (window as any).fixture.setTool("other", "hidden"))
    await settle(["message-0", "message-1", "message-3"])
    // Collapsed tools stay in the timeline; only hidden ones leave it.
    await page.evaluate(() => (window as any).fixture.setTool("read", "collapsed"))
    await settle(["message-0", "message-1", "message-2", "message-3"])

    await page.evaluate(() => (window as any).fixture.preset("nothing"))
    await settle(["message-0", "message-3"])
    await page.evaluate(() => (window as any).fixture.preset("everything"))
    await settle(["message-0", "message-1", "message-2", "message-3", "message-3"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
