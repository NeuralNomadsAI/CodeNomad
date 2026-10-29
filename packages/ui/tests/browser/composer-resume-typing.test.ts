import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"
import type { ViteDevServer } from "vite"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  ;({ server, url } = await startDeviceUploadFixture())
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

test("after a send the conversation keeps reading keys and the next typed character resumes the composer", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const prompts: unknown[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => {
      ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "tauri"
      ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
    })
    await page.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname.endsWith("/prompt")) prompts.push(route.request().postDataJSON())
      return route.fulfill({ json: route.request().url().endsWith("/prompt") ? { data: {} } : {} })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const input = page.locator("textarea:visible").first()
    const focused = () => page.evaluate(() => {
      const active = document.activeElement
      return active?.classList.contains("message-stream") ? "conversation" : active?.tagName.toLowerCase() ?? null
    })

    await input.fill("first prompt")
    await input.press("Enter")
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "")
    assert.equal(prompts.length, 1)
    assert.equal(await focused(), "conversation", "the send leaves the keyboard on the conversation for reading")

    for (const key of ["ArrowUp", "PageDown", "Space", "Home", "End"]) {
      await page.keyboard.press(key)
      assert.equal(await focused(), "conversation", `${key} keeps reading the conversation`)
    }
    assert.equal(await input.inputValue(), "")

    await page.keyboard.press("n")
    assert.equal(await focused(), "textarea", "a printable key returns to the composer")
    await page.keyboard.type("ext prompt")
    assert.equal(await input.inputValue(), "next prompt", "the character that resumed typing is kept, once")

    // Shift-typed characters resume too, and nothing is sent without Enter.
    await input.fill("")
    await page.evaluate(() => document.querySelector<HTMLElement>(".message-stream")?.focus())
    await page.keyboard.press("Shift+H")
    assert.equal(await input.inputValue(), "H")
    assert.equal(prompts.length, 1)

    // Controls keep their keys: typing on a focused button never edits the draft.
    await page.locator("#outside").focus()
    await page.keyboard.press("x")
    assert.equal(await focused(), "button")
    assert.equal(await input.inputValue(), "H")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
