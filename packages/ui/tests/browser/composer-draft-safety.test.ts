import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import type { ViteDevServer } from "vite"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  ;({ server, url } = await startDeviceUploadFixture())
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"] })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "tauri"
    ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
  })
  await page.route("**/api/**", route => route.fulfill({ json: { data: {} } }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(() => (window as any).fixture.submitOnEnter(true))
  return { page, errors, input: page.locator("textarea:visible").first() }
}

test("ArrowUp keeps a draft; sent history is recalled only from an empty composer", async () => {
  const { page, errors, input } = await setup()
  try {
    await input.fill("an old sent message")
    await input.press("Enter")
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "")
    // History records asynchronously after a send.
    await page.waitForTimeout(300)

    await input.pressSequentially("my draft")
    await input.press("Shift+Enter")
    await input.pressSequentially("second line")
    await input.press("Control+Home")
    await input.press("ArrowUp")
    await page.waitForTimeout(100)
    assert.equal(await input.inputValue(), "my draft\nsecond line", "a draft is never replaced by an old message")

    await input.fill("")
    await input.press("ArrowUp")
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "an old sent message")
    await input.press("ArrowDown")
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a long paste inserts its placeholder natively, keeping the caret and undo history", async () => {
  const { page, errors, input } = await setup()
  try {
    await input.pressSequentially("hello ")
    await page.evaluate(() => navigator.clipboard.writeText("x".repeat(200)))
    await input.press("Control+v")
    await input.pressSequentially(" more")
    assert.equal(await input.inputValue(), "hello [pasted #1] more", "typing after the paste follows the placeholder")
    assert.equal(await page.evaluate(() => (window as any).fixture.attachments().length), 1)

    // Chromium may group fast typing and the insertion into one undo step; what
    // matters is that undo goes past the paste and redo brings everything back.
    const undone: string[] = []
    for (let step = 0; step < 6; step += 1) {
      await input.press("Control+z")
      undone.push(await input.inputValue())
    }
    assert.equal(undone.at(-1), "", `undo continues past the paste: ${JSON.stringify(undone)}`)
    for (let step = 0; step < 6; step += 1) await input.press("Control+Shift+z")
    assert.equal(await input.inputValue(), "hello [pasted #1] more")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
