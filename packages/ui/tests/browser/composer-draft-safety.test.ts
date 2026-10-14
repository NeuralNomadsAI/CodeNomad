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

test("newline insertion cannot restore a stale caret over subsequent typing", async () => {
  const { page, errors, input } = await setup()
  try {
    await page.evaluate(() => (window as any).fixture.hotkeys({ "prompt-newline": [{ key: "F8" }] }))
    await input.fill("beforeafter")
    const immediate = await input.evaluate(element => {
      const textarea = element as HTMLTextAreaElement
      textarea.setSelectionRange(6, 6)
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", code: "F8", bubbles: true, cancelable: true }))
      const caret = textarea.selectionStart
      textarea.setRangeText("X", textarea.value.length, textarea.value.length, "end")
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "X" }))
      return caret
    })
    assert.equal(immediate, 7, "the insertion updates the caret inside the same event")
    await page.waitForTimeout(30)
    assert.equal(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart), 13)
    await input.pressSequentially("Y")
    assert.equal(await input.inputValue(), "before\nafterXY")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const { key, submitOnEnter, remapped } of [
  { key: "Shift+Enter", submitOnEnter: true },
  { key: "Control+Enter", submitOnEnter: true },
  { key: "Enter", submitOnEnter: false },
  { key: "Shift+Enter", submitOnEnter: false },
  { key: "F8", submitOnEnter: true, remapped: true },
]) {
  test(`newline ${key} keeps native undo and redo (submitOnEnter=${submitOnEnter})`, async () => {
    const { page, errors, input } = await setup()
    try {
      await page.evaluate(value => (window as any).fixture.submitOnEnter(value), submitOnEnter)
      if (remapped) await page.evaluate(() => (window as any).fixture.hotkeys({ "prompt-newline": [{ key: "F8" }] }))
      await input.pressSequentially("hello")
      await input.press("Control+a")
      await input.press(key)
      assert.equal(await input.inputValue(), "\n")
      assert.equal(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart), 1)
      await input.press("Control+z")
      assert.equal(await input.inputValue(), "hello", "undo restores the replaced draft")
      await input.press("Control+Shift+z")
      assert.equal(await input.inputValue(), "\n", "redo restores the newline")
      await input.press("Control+z")
      // The native input event must persist the undone value, not just change the DOM.
      await page.evaluate(() => (window as any).fixture.switch("other"))
      await page.evaluate(() => (window as any).fixture.switch("source"))
      assert.equal(await input.inputValue(), "hello")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("global type-to-focus and shell triggers ignore IME and consumed keys", async () => {
  const { page, errors, input } = await setup()
  try {
    await input.fill("")
    const placeholder = await input.getAttribute("placeholder")
    for (const flags of [{ isComposing: true }, { keyCode: 229 }, { consumed: true }]) {
      await page.evaluate(flags => {
        const field = document.querySelector<HTMLTextAreaElement>("textarea")!
        field.blur()
        const event = new KeyboardEvent("keydown", { key: "!", bubbles: true, cancelable: true, ...flags })
        if ("consumed" in flags) event.preventDefault()
        document.body.dispatchEvent(event)
      }, flags)
      assert.equal(await input.evaluate(element => document.activeElement === element), false)
      assert.equal(await input.getAttribute("placeholder"), placeholder, "ignored keys cannot enter shell mode")
      assert.equal(await input.inputValue(), "")
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a paste after undoing another sends the visible paste, never the undone one", async () => {
  const { page, errors, input } = await setup()
  const sent: string[] = []
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/prompt")) sent.push(route.request().postData() ?? "")
    return route.fulfill({ json: { data: {} } })
  })
  try {
    await page.evaluate(() => navigator.clipboard.writeText("A".repeat(200)))
    await input.press("Control+v")
    await input.press("Control+z")
    assert.equal(await input.inputValue(), "")
    await page.evaluate(() => navigator.clipboard.writeText("B".repeat(200)))
    await input.press("Control+v")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments().map((a: any) => a.source.value[0])), ["B"])
    await input.press("Enter")
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "")
    assert.equal(sent.length, 1)
    assert.ok(sent[0]!.includes("B".repeat(200)) && !sent[0]!.includes("A".repeat(200)), "only the visible paste is sent")
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
    assert.equal(await page.evaluate(() => (window as any).fixture.attachments().length), 0)
    for (let step = 0; step < 6; step += 1) await input.press("Control+Shift+z")
    assert.equal(await input.inputValue(), "hello [pasted #1] more")
    // Redo brings back the pasted content with its placeholder, not an empty token.
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments().map((a: any) => a.source)),
      [{ type: "text", value: "x".repeat(200) }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
