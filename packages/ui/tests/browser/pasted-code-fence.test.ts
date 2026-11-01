import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "pasted-code-fence",
    routes: [
      { path: "/fixture", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/pasted-code-fence.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("a long paste typed between fences sends once inside them and renders as one pasted code block", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"] })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const pasted = Array.from({ length: 32 }, (_, index) => `{"line": ${index + 1}}`).join("\n")
    const input = page.locator(".prompt-input-container textarea").first()
    await input.fill("Scalar fails:\n```json\n")
    await input.press("End")
    await page.evaluate(text => navigator.clipboard.writeText(text), pasted)
    await input.press("Control+v")
    assert.equal(await input.inputValue(), "Scalar fails:\n```json\n[pasted #1]", "the composer keeps the placeholder")
    await input.press("Shift+Enter")
    await input.pressSequentially("```")
    await page.locator(".send-button").click()
    await page.waitForFunction(() => (window as any).fixture.prompts.length === 1)

    // The model receives the pasted text exactly once, inside the fences.
    const [sent] = await page.evaluate(() => (window as any).fixture.prompts)
    assert.equal(sent.text, `Scalar fails:\n\`\`\`json\n${pasted}\n\`\`\``)

    const message = page.locator('[data-view="message-item"]').filter({ hasText: "Scalar fails:" })
    await message.waitFor()
    const disclosure = message.locator("details")
    assert.equal(await disclosure.count(), 1, "one pasted section")
    assert.match(await disclosure.locator("summary").innerText(), /Pasted text\s+32 lines/)

    await disclosure.locator("summary").click()
    await disclosure.locator(".code-block-header").first().waitFor()
    await message.getByText("Scalar fails:", { exact: true }).waitFor()
    assert.equal(await message.locator(".code-block-header").count(), 1,
      "the paste renders as a single code block, without empty blocks around it")
    assert.equal((await message.locator(".code-block-language").innerText()).trim().toLowerCase(), "json")
    assert.equal((await disclosure.locator("pre code").innerText()).trim(), pasted)

    await disclosure.getByRole("button", { name: "Copy pasted text block" }).click()
    // The system clipboard may hand line breaks back as CRLF.
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), pasted,
      "copy returns the pasted code without fences")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const { name, pasted, after } of [
  { name: "a paste ending in a line break keeps the closing fence typed right after it",
    pasted: Array.from({ length: 32 }, (_, index) => `row ${index + 1}`).join("\n") + "\n", after: "```\nAfter the block." },
  { name: "fence lines inside the paste stay literal code",
    pasted: Array.from({ length: 32 }, (_, index) => index === 15 ? "```" : `row ${index + 1}`).join("\n"), after: "\n```\nAfter the block." },
]) {
  test(name, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"] })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      const input = page.locator(".prompt-input-container textarea").first()
      await input.fill("Log:\n```\n")
      await input.press("End")
      await page.evaluate(text => navigator.clipboard.writeText(text), pasted)
      await input.press("Control+v")
      await input.evaluate((element, suffix) => {
        const field = element as HTMLTextAreaElement
        field.setRangeText(suffix, field.value.length, field.value.length, "end")
        field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: suffix }))
      }, after)
      await page.locator(".send-button").click()
      await page.waitForFunction(() => (window as any).fixture.prompts.length === 1)
      assert.equal((await page.evaluate(() => (window as any).fixture.prompts))[0].text, `Log:\n\`\`\`\n${pasted}${after}`)

      const code = pasted.endsWith("\n") ? pasted.slice(0, -1) : pasted
      const message = page.locator('[data-view="message-item"]').filter({ hasText: "Log:" })
      await message.waitFor()
      const disclosure = message.locator("details")
      assert.match(await disclosure.locator("summary").innerText(), /Pasted text\s+32 lines/)
      await disclosure.locator("summary").click()
      await disclosure.locator("pre code").first().waitFor()
      await message.getByText("After the block.", { exact: true }).waitFor()
      assert.equal(await disclosure.getByText("After the block.").count(), 0, "prose after the closer stays outside the fold")
      assert.equal(await message.locator(".code-block-header").count(), 1, "one code block")
      assert.equal((await disclosure.locator("pre code").innerText()).replace(/\n$/, ""), code, "the whole paste is literal code")
      await disclosure.getByRole("button", { name: "Copy pasted text block" }).click()
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), code)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
