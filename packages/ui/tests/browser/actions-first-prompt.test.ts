import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  ;({ url } = await borrowFixture({ name: "actions-first-prompt", routes: [{ path: "/first", html: '<html><body><input id="elsewhere" aria-label="Other control"><div id="root" style="display:flex;height:750px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/actions-first-prompt.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})

for (const failure of ["rotation", "ordinary"]) test(`a first prompt's delayed instruction failure preserves its draft (${failure})`, async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).firstPrompt.holdInstructions())
    await f.input.fill("Original first prompt"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).firstPrompt.creates() === 1)
    await f.page.evaluate(() => (window as any).firstPrompt.release())
    await f.page.waitForFunction(() => (window as any).firstPrompt.instructionsStarted() === 1)
    await f.page.getByLabel("Other control").fill("Working elsewhere")
    await f.page.evaluate(failure => {
      if (failure === "rotation") (window as any).firstPrompt.rotate()
      ;(window as any).firstPrompt.releaseInstructions(failure === "ordinary")
    }, failure)
    await f.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea.prompt-input"))
      .find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)?.value === "Original first prompt")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.evaluate(() => Boolean((window as any).firstPrompt.alert())), failure === "ordinary")
    assert.equal(await f.page.evaluate(() => (window as any).firstPrompt.calls().length), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
after(async () => { await browser?.close() })
async function setup() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).firstPrompt))
  return { page, errors, input: page.locator("textarea.prompt-input:visible").first() }
}
for (const outcome of ["rotation", "newer-draft", "closed-reused", "normal"]) test(`first prompt preserves ownership during delayed creation (${outcome})`, async () => {
  const f = await setup()
  try {
    await f.input.fill("Original first prompt"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).firstPrompt.creates() === 1)
    if (outcome === "closed-reused") await f.page.evaluate(() => { (window as any).firstPrompt.close(); (window as any).firstPrompt.reuse() })
    if (outcome !== "normal") {
      await f.input.fill("Newer first draft"); await f.page.getByLabel("Other control").fill("Working elsewhere")
    }
    if (outcome === "rotation") await f.page.evaluate(() => (window as any).firstPrompt.rotate())
    await f.page.evaluate(() => (window as any).firstPrompt.release())
    if (outcome === "normal") {
      await f.page.waitForFunction(() => (window as any).firstPrompt.calls().length === 1)
      assert.equal(await f.page.evaluate(() => (window as any).firstPrompt.selected()), "created")
    } else {
      await f.page.waitForTimeout(150)
      assert.equal(await f.input.inputValue(), "Newer first draft")
      assert.equal(await f.page.evaluate(() => (window as any).firstPrompt.selected()), null)
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
      assert.equal(await f.page.evaluate(() => (window as any).firstPrompt.alert()), null)
      assert.equal(await f.page.evaluate(() => (window as any).firstPrompt.calls().length), outcome === "newer-draft" ? 1 : 0)
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
