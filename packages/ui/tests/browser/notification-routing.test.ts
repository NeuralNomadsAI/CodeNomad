import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"

// The status-tokens fixture renders the real notification routing table under Settings → Chat.
let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("status-tokens") })
after(async () => { await fixture?.close() })

test("dragging down a notification column sets every crossed box and writes the table once, on release", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(`${fixture.url}?saveDelay=400`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    // The History column: one box per notification category.
    const boxes = page.locator(".notification-routing tbody tr td:nth-child(3) input")
    await boxes.first().scrollIntoViewIfNeeded()
    const checked = () => boxes.evaluateAll(inputs => inputs.slice(0, 5).map(input => (input as HTMLInputElement).checked))
    const center = async (index: number) => {
      const box = (await boxes.nth(index).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const initial = await checked()
    const target = !initial[0]
    const savesBefore = await page.evaluate(() => (window as any).fixture.saves())
    const first = await center(0), fifth = await center(4)
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    await page.mouse.move(fifth.x, fifth.y, { steps: 10 })
    // During the drag the table shows every crossed box and writes nothing.
    assert.deepEqual(await checked(), [target, target, target, target, target])
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBefore, 0)
    await page.mouse.up()
    await page.waitForFunction(({ target }) => {
      const routing = (window as any).fixture.preferences().notificationRouting
      return ["needsInput", "sessionDone", "updates", "files", "projects"].every(category => routing[category].history === target)
    }, { target })
    assert.deepEqual(await checked(), [target, target, target, target, target])
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBefore, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("successive notification sweeps write one after another, the last one winning, and ask for System permission once", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(`${fixture.url}?saveDelay=400`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const categories = ["needsInput", "sessionDone", "updates", "files", "projects"]
    const column = (index: number) => page.locator(`.notification-routing tbody tr td:nth-child(${index}) input`)
    await column(3).first().scrollIntoViewIfNeeded()
    const sweep = async (index: number) => {
      const boxes = column(index)
      const first = (await boxes.nth(0).boundingBox())!, fifth = (await boxes.nth(4).boundingBox())!
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
      await page.mouse.down()
      await page.mouse.move(fifth.x + fifth.width / 2, fifth.y + fifth.height / 2, { steps: 6 })
      await page.mouse.up()
    }
    const saved = (destination: string) => page.evaluate(({ categories, destination }) =>
      categories.map(category => (window as any).fixture.preferences().notificationRouting[category][destination]), { categories, destination })

    // Down the History column and straight back over it: the second write waits for the first.
    const target = !(await column(3).first().isChecked())
    const savesBefore = await page.evaluate(() => (window as any).fixture.saves())
    await sweep(3)
    await sweep(3)
    await page.waitForFunction(({ categories, target }) => categories.every(category =>
      (window as any).fixture.preferences().notificationRouting[category].history === target), { categories, target: !target })
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBefore, 2)
    assert.equal(await page.evaluate(() => (window as any).fixture.maxInFlight()), 1)
    assert.deepEqual(await saved("history"), [!target, !target, !target, !target, !target])

    // Checking five System boxes in one sweep asks for permission once.
    await page.evaluate(async () => {
      const fixture = (window as any).fixture
      const routing = structuredClone(fixture.preferences().notificationRouting)
      for (const category of Object.keys(routing)) routing[category].system = false
      await fixture.updatePreferences({ notificationRouting: routing })
    })
    await page.waitForFunction(() => [...document.querySelectorAll(".notification-routing tbody tr td:nth-child(4) input")]
      .every(input => !(input as HTMLInputElement).checked))
    const checksBefore = await page.evaluate(() => (window as any).fixture.systemChecks())
    await sweep(4)
    await page.waitForFunction(({ categories }) => categories.every(category =>
      (window as any).fixture.preferences().notificationRouting[category].system), { categories })
    assert.equal(await page.evaluate(() => (window as any).fixture.systemChecks()) - checksBefore, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
