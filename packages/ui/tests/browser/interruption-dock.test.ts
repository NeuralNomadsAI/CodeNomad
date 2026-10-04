import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { prepareInterruptionDock } from "./fixtures/interruption-dock-preparation"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>> | undefined
async function disposeFixture() {
  try { await browser?.close() }
  finally {
    if (server) await server.close()
    else await cache?.dispose()
  }
}
before(async () => {
  try {
    cache = await createFixtureCache()
    const shutdown = createFixtureShutdown(cache)
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
      cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "interruptions-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/interruption-dock.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    await prepareInterruptionDock(server)
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) {
    try { await disposeFixture() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Interruption fixture setup and cleanup failed") }
    throw error
  }
})
after(disposeFixture)

async function fixture(width = 1100, theme: "light" | "dark" = "light") {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length))
  await page.evaluate(theme => (window as any).fixture.theme(theme), theme)
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme)
  return { page, errors }
}
const answer = (page: Page) => page.locator('.interruption-dock input[type="text"]:visible')

async function assertBoundedActions(page: Page, footerSelector = ".form-request-actions") {
  const metrics = await page.locator(".interruption-dock").evaluate((dock, footerSelector) => {
    const panel = dock.getBoundingClientRect()
    const footerElement = dock.querySelector(footerSelector)!
    const footer = footerElement.getBoundingClientRect()
    return {
      bounded: panel.y >= 0 && panel.bottom <= innerHeight && panel.height <= innerHeight * 0.45,
      overflow: document.documentElement.scrollWidth > innerWidth || dock.scrollWidth > dock.clientWidth,
      footerInside: footer.y >= panel.y && footer.bottom <= panel.bottom,
      buttonsInside: Array.from(footerElement.querySelectorAll("button")).every(button => {
        const rect = button.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return rect.x >= panel.x && rect.right <= panel.right && rect.y >= footer.y && rect.bottom <= footer.bottom
          && Boolean(hit && button.contains(hit))
      }),
    }
  }, footerSelector)
  assert.deepEqual(metrics, { bounded: true, overflow: false, footerInside: true, buttonsInside: true })
}

for (const width of [393, 1100]) for (const theme of ["light", "dark"] as const) {
  test(`long native questions remain bounded and keyboard-operable at ${width}px in ${theme}`, async () => {
    const { page, errors } = await fixture(width, theme)
    const capture = (state: string) => page.screenshot({ path: join(tmpdir(), "opencode", `interruption-dock-${width}-${theme}-${state}.png`) })
    try {
      await page.locator(".prompt-input").fill("Keep the release draft")
      await page.evaluate(() => (window as any).fixture.liveAsk(true))
      const fields = page.locator(".interruption-dock .form-request-fields")
      await fields.waitFor()
      await page.getByRole("radio", { name: /^Gradual rollout/ }).waitFor()
      assert.equal(await page.locator(".message-stream .form-request, .message-stream .interruption-receipt").count(), 0)
      for (const question of await page.locator(".interruption-dock .form-request-description").allTextContents()) {
        assert.equal(await page.locator(".message-stream").getByText(question, { exact: true }).count(), 0)
      }
      assert.equal(await page.getByRole("button", { name: "Next request", exact: true }).count(), 0)
      assert.equal(await fields.evaluate(element => element.scrollHeight > element.clientHeight), true)
      await assertBoundedActions(page)
      await capture("open")
      const hierarchy = await page.locator(".form-request-field").first().evaluate(field => {
        const question = getComputedStyle(field.querySelector(".form-request-description")!)
        const choice = getComputedStyle(field.querySelector(".form-request-choice-description")!)
        return { questionSize: parseFloat(question.fontSize), choiceSize: parseFloat(choice.fontSize),
          questionWeight: Number(question.fontWeight), choiceWeight: Number(choice.fontWeight), distinctColor: question.color !== choice.color }
      })
      assert.ok(hierarchy.questionSize > hierarchy.choiceSize || hierarchy.questionWeight > hierarchy.choiceWeight,
        `Question must outrank option descriptions: ${JSON.stringify(hierarchy)}`)
      assert.equal(hierarchy.distinctColor, true)

      const first = page.getByRole("radio", { name: /^Gradual rollout/ })
      await first.focus()
      await page.keyboard.press("Space")
      await page.keyboard.press("ArrowDown")
      assert.equal(await page.getByRole("radio", { name: /^All workspaces/ }).isChecked(), true)
      await page.keyboard.press("Tab")
      assert.equal(await page.getByRole("checkbox", { name: /^Browser coverage/ }).evaluate(element => element === document.activeElement), true)
      await page.keyboard.press("Space")
      await page.keyboard.press("Tab")
      await page.keyboard.press("Space")
      await assertBoundedActions(page)
      await answer(page).fill("Include the keyboard shortcuts and deployment schedule.")
      await page.waitForFunction(() => {
        const input = document.activeElement
        const scroller = input?.closest(".form-request-fields")
        const footer = input?.closest(".form-request")?.querySelector(".form-request-actions")
        if (!input?.matches('input[type="text"]') || !scroller || !footer) return false
        const control = input.getBoundingClientRect(), bounds = scroller.getBoundingClientRect()
        return control.top >= bounds.top && control.bottom <= bounds.bottom && control.bottom <= footer.getBoundingClientRect().top
      })
      await capture("scrolled")
      await assertBoundedActions(page)

      const collapse = page.getByRole("button", { name: "Collapse requests", exact: true })
      await collapse.focus()
      await page.keyboard.press("Enter")
      assert.equal(await fields.isVisible(), false)
      const panel = await page.locator(".interruption-dock").boundingBox()
      const header = await page.locator(".interruption-dock > header").boundingBox()
      assert.ok(panel && header && panel.height <= header.height + 3 && panel.height < 80)
      await capture("collapsed")
      await page.keyboard.press("Enter")
      assert.equal(await answer(page).inputValue(), "Include the keyboard shortcuts and deployment schedule.")
      assert.equal(await page.getByRole("radio", { name: /^All workspaces/ }).isChecked(), true)
      await answer(page).focus()
      await page.keyboard.press("Tab")
      assert.equal(await page.locator(".form-request-actions button").first().evaluate(element => element === document.activeElement), true)
      await page.keyboard.press("Tab")
      await page.keyboard.press("Enter")
      await page.locator(".interruption-dock").waitFor({ state: "detached" })
      await page.locator(".interruption-receipt dd").filter({ hasText: "All workspaces" }).waitFor()
      const receiptColors = await page.locator(".interruption-receipt").evaluate(receipt => {
        const probe = document.createElement("span")
        probe.style.color = "var(--text-primary)"
        receipt.append(probe)
        const primary = getComputedStyle(probe).color
        probe.remove()
        return { primary, answers: Array.from(receipt.querySelectorAll("dd"), answer => getComputedStyle(answer).color) }
      })
      assert.deepEqual(receiptColors.answers, Array(3).fill(receiptColors.primary), "Every receipt answer must use resolved primary text color")
      assert.deepEqual(await page.locator(".question-receipt-prompt").allTextContents(), [
        "How should we deploy the updated interruption dock to existing workspaces?",
        "Which checks must finish before the release can proceed?",
        "What additional release notes should the team include?",
      ])
      assert.deepEqual(await page.locator(".question-receipt-answers .question-receipt-label").allTextContents(), [
        "All workspaces", "Browser coverage", "Visual review", "Include the keyboard shortcuts and deployment schedule.",
      ])
      assert.deepEqual(await page.locator(".question-receipt-answers .question-receipt-description").allTextContents(), [
        "Release the updated panel everywhere after the browser checks pass and support documentation is ready.",
        "Verify narrow layouts, keyboard navigation, persistent answers and bounded panel actions.",
        "Review both light and dark appearances, question hierarchy and lengthy option descriptions.",
      ])
      assert.deepEqual(await page.locator(".question-receipt summary").allTextContents(), ["Other choices (2)", "Other choices (1)"])
      assert.equal(await page.locator(".question-receipt details[open]").count(), 0)
      assert.equal(await page.locator(".question-receipt details").getByText("All workspaces", { exact: true }).count(), 0)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.replies[0].answer), {
        q0: "All workspaces", q1: ["Browser coverage", "Visual review"], q2: "Include the keyboard shortcuts and deployment schedule.",
      })
      assert.equal(await page.locator(".prompt-input").inputValue(), "Keep the release draft")
      await page.waitForFunction(() => document.activeElement?.matches(".prompt-input"))
      await capture("completed")
      const choices = page.locator(".question-receipt summary").first()
      await choices.focus()
      await page.keyboard.press("Enter")
      assert.equal(await page.locator(".question-receipt details[open]").count(), 1)
      assert.equal(await page.getByText("Keep the new interaction in preview while collecting keyboard and mobile accessibility feedback.", { exact: true }).isVisible(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await capture("choices")
      await page.evaluate(() => (window as any).fixture.rehydrate())
      await page.locator(".question-receipt-answers .question-receipt-label").filter({ hasText: "All workspaces" }).waitFor()
      assert.equal(await page.locator(".question-receipt-answers .question-receipt-description").count(), 3)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("a single request has no navigation; the badge restores the collapsed editor without moving the transcript", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).fill("Preserved answer")
    assert.equal(await page.getByRole("button", { name: "Next request", exact: true }).count(), 0)
    assert.equal(await page.locator('.interruption-position').count(), 0)
    assert.equal(await page.getByRole("button", { name: "View in conversation" }).count(), 0)
    await page.getByRole("button", { name: "Collapse requests", exact: true }).click()
    assert.equal(await answer(page).count(), 0)
    const compact = await page.locator('.interruption-dock').boundingBox()
    assert.ok(compact && compact.height < 80)
    await page.locator('.permission-center-trigger').click()
    assert.equal(await answer(page).inputValue(), "Preserved answer")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("answering in the dock preserves the Mission reader and does not reveal the transcript", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.missionReader() })
    await page.locator('.mission-transcript-content[inert]').waitFor({ state: "attached" })
    await answer(page).fill("Answer without leaving the Mission reader")
    assert.equal(await page.getByRole("button", { name: "View in conversation" }).count(), 0)
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => (window as any).fixture.hasMissionReader()), true)
    assert.equal(await page.locator('.mission-transcript-content').evaluate(element => element.hasAttribute("inert")), true)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.replies[0].answer), { q0: "Answer without leaving the Mission reader" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("answering in the dock preserves the open file preview and composer draft", async () => {
  const { page, errors } = await fixture()
  try {
    await page.locator(".prompt-input").fill("Keep my preview draft")
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.preview() })
    await page.waitForFunction(() => (window as any).fixture.hasPreview())
    await answer(page).fill("Answer without closing the preview")
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => (window as any).fixture.hasPreview()), true)
    assert.equal(await page.locator(".prompt-input").inputValue(), "Keep my preview draft")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("native receipt metadata wins and custom multiline answers stay literal", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.liveAsk(true))
    const search = await page.evaluate(() => (window as any).fixture.complete([
      ["Gradual rollout"], ["Browser coverage", "Visual review"], ["Custom <answer>\nSecond line"],
    ], { answers: [["WRONG OUTPUT ANSWER"]] }))
    await page.locator(".question-receipt").waitFor()
    assert.deepEqual(await page.locator(".question-receipt-answers .question-receipt-label").allTextContents(), [
      "Gradual rollout", "Browser coverage", "Visual review", "Custom <answer>\nSecond line",
    ])
    assert.equal(search.join("\n").includes("WRONG OUTPUT ANSWER"), false)
    assert.equal(search.includes("Custom <answer>\nSecond line"), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("malformed answers stay unknown and do not leak image payloads into search", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.liveAsk(true))
    const unknownSearch = await page.evaluate(() => (window as any).fixture.complete([
      [{ type: "image", data: "PRIVATE_IMAGE_BYTES" }], [], ["Unlisted answer"],
    ], { answers: [["WRONG OUTPUT ANSWER"]] }))
    await page.getByText("Answer unavailable", { exact: true }).waitFor()
    assert.deepEqual(await page.locator(".question-receipt-empty").allTextContents(), ["Answer unavailable", "No answer"])
    assert.deepEqual(await page.locator(".question-receipt summary").allTextContents(), ["Choices offered (3)", "Other choices (3)"])
    assert.deepEqual(await page.locator(".question-receipt-answers .question-receipt-label").allTextContents(), ["Unlisted answer"])
    assert.equal(await page.locator(".question-receipt-answers .question-receipt-description").count(), 0)
    assert.equal(unknownSearch.join("\n").includes("PRIVATE_IMAGE_BYTES"), false)
    assert.equal(unknownSearch.join("\n").includes("WRONG OUTPUT ANSWER"), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("failed native questions use the shared error shell, never an answered receipt", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => { (window as any).fixture.liveAsk(); (window as any).fixture.toolError() })
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().question?.parts["question-tool"]?.data?.state?.status), "error")
    await page.locator(".tool-call-error-content").filter({ hasText: "Question cancelled" }).waitFor()
    assert.equal(await page.locator(".question-receipt").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("new permissions do not replace the draft; bounded navigation stays separate from collapse", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).fill("Keep typing")
    await page.evaluate(() => (window as any).fixture.permission())
    assert.equal(await answer(page).inputValue(), "Keep typing")
    assert.equal(await answer(page).evaluate(element => element === document.activeElement), true)
    assert.equal(await page.getByRole("button", { name: "Next request", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Collapse requests", exact: true }).click()
    await page.locator('.permission-center-trigger').click()
    assert.equal(await answer(page).inputValue(), "Keep typing")
    await page.getByRole("button", { name: "Previous request", exact: true }).click()
    await page.getByRole("button", { name: "Allow Once", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Previous request", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Next request", exact: true }).click()
    assert.equal(await answer(page).inputValue(), "Keep typing")
    assert.equal(await page.getByRole("button", { name: "Collapse requests", exact: true }).getAttribute("aria-expanded"), "true")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("answering outside loaded history preserves the composer and native receipt survives reload", async () => {
  const { page, errors } = await fixture()
  try {
    await page.locator(".prompt-input").fill("Keep my draft")
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).waitFor()
    assert.equal(await page.locator('.message-stream .form-request').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().ids.includes("msg_0000")), false)
    await page.getByRole("button", { name: "Collapse requests", exact: true }).click()
    await page.locator(".permission-center-trigger").click()
    await answer(page).fill("Use the dock")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.equal(await answer(page).inputValue(), "Use the dock")
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    assert.equal(await page.locator(".prompt-input").inputValue(), "Keep my draft")
    await page.evaluate(() => (window as any).fixture.rehydrate())
    await page.locator(".interruption-receipt dd").filter({ hasText: "Use the dock" }).waitFor()
    assert.equal(await page.locator(".question-receipt-prompt").innerText(), "Which approach?")
    assert.equal(await page.evaluate(() => (window as any).fixture.replies.length), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a live native question becomes a durable transcript receipt after dock submission", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.liveAsk())
    await answer(page).fill("Native event answer")
    assert.equal(await page.locator('.message-stream .interruption-receipt').count(), 0)
    assert.equal(await page.getByRole("button", { name: "Respond near the composer" }).count(), 0)
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.matches('.prompt-input'))
    await page.locator(".interruption-receipt dd").filter({ hasText: "Native event answer" }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("partial answers survive refresh, request navigation and session remount; failed sends stay retryable", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).fill("Partial answer")
    await page.evaluate(() => { (window as any).fixture.refresh(); (window as any).fixture.other() })
    await page.getByRole("button", { name: "Next request", exact: true }).click()
    await answer(page).fill("Other answer")
    await page.evaluate(() => (window as any).fixture.switch("other"))
    assert.equal(await answer(page).inputValue(), "Other answer")
    await page.evaluate(() => (window as any).fixture.switch("s"))
    assert.equal(await answer(page).inputValue(), "Partial answer")
    await page.evaluate(() => (window as any).fixture.fail(true))
    await page.locator('.interruption-dock button[type="submit"]:visible').click()
    await page.getByText("Reply failed", { exact: true }).waitFor()
    assert.equal(await answer(page).inputValue(), "Partial answer")
    await page.evaluate(() => { (window as any).fixture.fail(false); (window as any).fixture.hold() })
    await page.locator('.interruption-dock button[type="submit"]:visible').click()
    assert.equal(await page.locator('.interruption-dock button[type="submit"]:visible').isDisabled(), true)
    assert.equal(await answer(page).isDisabled(), true)
    await page.evaluate(() => (window as any).fixture.release())
    await page.waitForFunction(() => !(window as any).fixture.snapshot().forms.includes("question"))
    assert.equal(await answer(page).inputValue(), "Other answer")
    assert.equal(await page.evaluate(() => (window as any).fixture.replies.length), 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("mobile dock handles source-less permissions, global Forms and remote settlement", async () => {
  const { page, errors } = await fixture(393)
  try {
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.permission() })
    await page.evaluate(() => (window as any).fixture.focus("permission"))
    await page.getByRole("button", { name: "Allow Once", exact: true }).waitFor()
    assert.equal(await page.locator(".tool-call-permission-buttons button").count(), 3)
    await assertBoundedActions(page, ".tool-call-permission-buttons")
    await page.screenshot({ path: join(tmpdir(), "opencode", "interruption-dock-393-light-permission.png") })
    await page.getByRole("button", { name: "Allow Once", exact: true }).click()
    await answer(page).waitFor()
    await page.evaluate(() => (window as any).fixture.remoteReply())
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.global())
    await page.getByText("Service request", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "View in conversation" }).count(), 0)
    await answer(page).fill("Global answer")
    await page.screenshot({ path: join(tmpdir(), "interruption-dock-mobile.png") })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const bounds = await page.locator(".interruption-dock").boundingBox()
    assert.ok(bounds && bounds.height < 400 && bounds.y >= 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
