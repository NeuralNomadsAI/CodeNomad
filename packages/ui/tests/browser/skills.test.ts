import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "skills-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/skills.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("skills use the existing attachments bar without a second composer row", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    // No dedicated Skills button or dialog: the @ menu is the only entry point.
    assert.equal(await page.getByRole("button", { name: "Skills", exact: true }).count(), 0)
    assert.equal(await page.getByRole("dialog").count(), 0)
    const textarea = page.locator(".prompt-input-container textarea").first()
    assert.equal(await textarea.getAttribute("placeholder"), "Type your message, @file, @agent, @skill, or paste images and text...")
    await textarea.fill("@rev")
    await page.waitForFunction(() => (window as any).fixture.pending().length === 1)
    await page.evaluate(() => (window as any).fixture.resolve(0, "review"))
    await page.locator(".dropdown-item", { hasText: "review" }).first().evaluate(el => (el as HTMLElement).click())
    await page.waitForFunction(() => (window as any).fixture.selected().length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [{ type: "skill", id: "review", name: "review" }])
    // The @query token is dropped when the badge attaches.
    assert.ok(!(await textarea.inputValue()).includes("@rev"))
    const historical = page.locator('[data-view="message-item"][data-message-id="history"]')
    const skillOnly = page.locator('[data-view="message-item"][data-message-id="skill-only"]')
    await historical.getByText("Review", { exact: true }).waitFor({ timeout: 5000 })
    await skillOnly.getByText("Review", { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await historical.locator(".attachment-chip").count(), 1)
    assert.equal(await page.getByText("PRIVATE-SKILL-INSTRUCTIONS", { exact: false }).count(), 0)
    // Selecting the same skill again does not duplicate the badge.
    await textarea.fill("@rev")
    await page.waitForFunction(() => (window as any).fixture.pending().length === 2)
    await page.evaluate(() => (window as any).fixture.resolve(1, "review"))
    await page.locator(".dropdown-item", { hasText: "review" }).first().evaluate(el => (el as HTMLElement).click())
    assert.equal((await page.evaluate(() => (window as any).fixture.selected())).length, 1)
    const skillChip = page.locator(".attachment-chip").filter({ has: page.locator(".font-mono", { hasText: "review" }) })
    assert.equal(await skillChip.count(), 1)
    assert.equal(await page.locator(".prompt-skill-attachments").count(), 0)
    assert.equal(await page.locator(".prompt-input-wrapper .attachment-chip").count(), 0)
    await textarea.fill("Keep this draft")
    await page.evaluate(() => (window as any).fixture.addFile())
    assert.equal(await page.locator(".attachment-chip .font-mono").count(), 2)
    assert.equal(await page.locator(".attachment-chip .font-mono").evaluateAll(chips =>
      chips[0].parentElement!.parentElement === chips[1].parentElement!.parentElement), true, "files and skills share one bar")
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (process.env.CODENOMAD_SKILLS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_SKILLS_CAPTURE, fullPage: true })
    await skillChip.getByRole("button", { name: "Remove attachment", exact: true }).click()
    assert.equal(await textarea.inputValue(), "Keep this draft")
    assert.equal(await skillChip.count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [{ type: "file", path: "./notes.md", mime: "text/plain", data: undefined }])
    await page.locator(".attachment-chip").filter({ hasText: "@notes.md" }).getByRole("button", { name: "Remove attachment", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [])
    // The retired /skills shortcut no longer opens a picker or reads the catalog.
    const readsBefore = await page.evaluate(() => (window as any).fixture.pending().length)
    await textarea.fill("/skills")
    await page.waitForTimeout(300)
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.pending().length), readsBefore)
    assert.equal(await textarea.inputValue(), "/skills")
    await textarea.fill("@rev")
    await page.waitForFunction(() => (window as any).fixture.pending().length === 3)
    await page.evaluate(() => (window as any).fixture.resolve(2, "review"))
    await page.locator(".dropdown-item", { hasText: "review" }).first().evaluate(el => (el as HTMLElement).click())
    await textarea.fill("Use this skill")
    await page.locator(".send-button").click()
    await page.waitForFunction(() => (window as any).fixture.sends.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.sends[0][1].map((item: any) => item.source)), [{ type: "skill", id: "review", name: "review" }])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), [])
    assert.equal(await skillChip.count(), 0, "sending clears the skill from the draft")
    const sent = page.locator('[data-view="message-item"][data-message-id="sent"]')
    await sent.getByText("review", { exact: true }).waitFor()
    assert.equal(await sent.locator(".attachment-chip").count(), 1)
    assert.equal(await sent.getByText("Use this skill", { exact: true }).isVisible(), true)
    assert.equal(await sent.locator(".tool-call").count(), 0, "explicit attachments do not invent tool calls")
    await page.evaluate(() => (window as any).fixture.reloadHistory())
    await sent.getByText("review", { exact: true }).waitFor()
    assert.equal(await sent.locator(".attachment-chip").count(), 1, "skill label survives native history reload")
    assert.equal(await page.getByText("PRIVATE-SKILL-INSTRUCTIONS", { exact: false }).count(), 0)
    await sent.scrollIntoViewIfNeeded()
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (process.env.CODENOMAD_SKILLS_SENT_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_SKILLS_SENT_CAPTURE, fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, touch] of [["en", false], ["en", true], ["he", true]] as const) {
  test(`long skill labels stay readable in narrow ${locale} ${touch ? "touch" : "desktop"} transcripts`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: touch, isMobile: touch })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    try {
      await page.goto(`${url}?longSkill=1&locale=${locale}`)
      const item = page.locator('[data-view="message-item"][data-message-id="history"]')
      const chip = item.locator(".attachment-chip")
      await chip.waitFor()
      assert.equal(await chip.textContent(), "m".repeat(64) + "-END-SKILL")
      assert.equal(await page.locator("html").getAttribute("dir"), locale === "he" ? "rtl" : "ltr")
      const bounds = await chip.evaluate(el => {
        const message = el.closest('[data-view="message-item"]') as HTMLElement
        const messageRect = message.getBoundingClientRect(), chipRect = el.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        const rects = [...range.getClientRects()]
        return { messageFits: message.scrollWidth <= message.clientWidth + 1,
          chipFits: chipRect.left >= messageRect.left && chipRect.right <= messageRect.right,
          textFits: rects.every(rect => rect.left >= chipRect.left - 1 && rect.right <= chipRect.right + 1),
          wraps: rects.length > 1 }
      })
      assert.deepEqual(bounds, { messageFits: true, chipFits: true, textFits: true, wraps: true })
      if (process.env.CODENOMAD_SKILLS_SENT_CAPTURE) await page.screenshot({
        path: process.env.CODENOMAD_SKILLS_SENT_CAPTURE.replace(/\.png$/, `-${locale}-${touch}.png`), fullPage: true })
    } finally { await page.close() }
  })
}
