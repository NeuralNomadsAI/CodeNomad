import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

let browser: Browser, url: string
const captures = resolve(".tmp/actions-settlement/captures", `${Date.now()}-${process.pid}`)
before(async () => {
  await mkdir(captures, { recursive: true })
  ;({ url } = await borrowFixture({ name: "actions-continuations", routes: [{ path: "/actions", html: '<html><body><input id="elsewhere" aria-label="Other control"><div id="root" style="display:flex;height:700px;width:1000px"></div><script type="module" src="/tests/browser/fixtures/actions-continuations.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
async function setup() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, locale: "en-US" })
  const errors: string[] = [], files: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (/\/files(?:\/search)?\?/.test(route.request().url())) files.push(route.request().url())
    return route.fulfill({ json: route.request().url().includes("permission-receipts") ? { receipts: [] } : [] })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).continuations)).catch(async error => {
    console.log("Continuation fixture readiness", errors, await page.locator("body").innerText())
    throw error
  })
  return { page, errors, files, input: page.locator("textarea:visible").first() }
}
async function editQueue(f: Awaited<ReturnType<typeof setup>>) {
  await f.page.evaluate(() => (window as any).continuations.seedQueued())
  await f.page.locator('[data-message-id="queued"][data-view="message-item"]').hover()
  await f.page.getByRole("button", { name: "Edit queued prompt", exact: true }).click()
  await f.page.waitForFunction(() => (window as any).continuations.cancelStarted() === 1)
}
for (const outcome of ["explicit_request_uncertain", "session_environment_failed", "PROVIDER_ACCOUNT_SELECTION_FAILED", "ordinary_failure"]) test(`real SDK HTTP 502 keeps source draft and appropriate feedback (${outcome})`, async () => {
  const f = await setup()
  let sends = 0, entered!: () => void, release!: () => void
  const started = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  try {
    await f.page.route("**/workspaces/http-outcome/instance/api/session/same/prompt", async route => {
      sends++; entered(); await held
      await route.fulfill({ status: 502, json: { error: outcome, message: "Fixed backend warning" } })
    })
    await f.page.evaluate(async () => {
      const { sdkManager } = await import("/src/lib/sdk-manager.ts")
      const { instances } = await import("/src/stores/instances.ts")
      const client = sdkManager.createClient("http-outcome", "/workspaces/http-outcome/instance")
      instances().get("A").client.session.prompt = (input: any, options: any) => client.session.prompt(input, options)
    })
    await f.input.fill("Source prompt sent once"); await f.input.press("Enter")
    await started
    await f.page.getByLabel("Other control").focus()
    release()
    if (outcome === "explicit_request_uncertain") {
      const status = f.page.locator(".composer-notice[role=status]")
      await status.waitFor()
      assert.equal(await status.count(), 1)
      assert.equal(await status.getAttribute("aria-live"), "polite")
      assert.equal(await f.page.getByRole("dialog").count(), 0)
      assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    } else {
      await f.page.getByRole("dialog", { name: "Send failed" }).waitFor()
      assert.equal(await f.page.locator(".composer-notice[role=status]").count(), 0)
      assert.equal((await f.page.evaluate(() => (window as any).continuations.alert())).title, "Send failed")
    }
    assert.equal(await f.input.inputValue(), "Source prompt sent once")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.draft("B")), "")
    assert.equal(sends, 1)
    assert.deepEqual(f.errors, [])
  } finally { release(); await f.page.close() }
})
for (const change of ["text", "attachment", "text-aba"]) test(`queued edit preserves intervening ${change} and external focus`, async () => {
  const f = await setup()
  try {
    await editQueue(f)
    if (change !== "attachment") await f.input.fill("New draft")
    if (change === "text-aba") await f.input.fill("")
    if (change === "attachment") await f.page.evaluate(() => (window as any).continuations.addAttachment())
    await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), change === "text" ? "New draft" : "")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    if (change === "attachment") assert.deepEqual(await f.page.evaluate(() => (window as any).continuations.attachments().map((item: any) => item.source.id)), ["new-skill"])
    await f.page.getByRole("button", { name: "Restore saved prompt", exact: true }).waitFor()
    if (change === "text") await f.page.screenshot({ path: resolve(captures, "queued-edit-newer-draft.png") })
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt").length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("normal queued edit restores known text and attachments, preserving focus chosen while cancellation waits", async () => {
  const f = await setup()
  try {
    await editQueue(f)
    await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Original queued text")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.deepEqual(await f.page.evaluate(() => (window as any).continuations.attachments().map((item: any) => item.source.id)), ["original-skill"])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a lost cancellation acknowledgement retains the known payload without claiming acceptance or replaying", async () => {
  const f = await setup()
  try {
    await editQueue(f)
    await f.page.evaluate(() => (window as any).continuations.loseCancelAck())
    await f.input.fill("Newer draft"); await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "Newer draft")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.locator(".composer-notice").filter({ hasText: "Original queued text" }).count(), 1)
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt").length, 0)
    assert.equal(await f.page.evaluate(() => (window as any).continuations.cancelStarted()), 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("recovery becomes available when an older send settles without overwriting its newer queue recovery", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).continuations.seedQueued())
    await f.page.evaluate(() => (window as any).fixture.block("instruction"))
    await f.input.fill("Earlier send"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "instruction"))
    await f.page.locator('[data-message-id="queued"][data-view="message-item"]').hover()
    await f.page.getByRole("button", { name: "Edit queued prompt", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).continuations.cancelStarted() === 1)
    await f.input.fill("Newer draft"); await f.input.fill("")
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    const restore = f.page.getByRole("button", { name: "Restore saved prompt", exact: true })
    await restore.waitFor()
    assert.equal(await restore.isEnabled(), false)
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).fixture.release() })
    await f.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(button => button.textContent?.includes("Restore saved prompt") && !button.disabled))
    await restore.click()
    assert.equal(await f.input.inputValue(), "Original queued text")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt").length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("queued cancellation accepted on A remains recoverable on A after displaying B", async () => {
  const f = await setup()
  try {
    await editQueue(f)
    await f.page.evaluate(() => (window as any).fixture.select("B"))
    await f.input.fill("Keep B draft")
    await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "Keep B draft")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    await f.page.evaluate(() => (window as any).fixture.select("A"))
    await f.page.getByRole("button", { name: "Restore saved prompt", exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Original queued text")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt").length, 0)
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "prompt"))
    const prompts = (await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt")
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].target, "A")
    assert.equal(prompts[0].input.text, "Original queued text\n\nhidden native context")
    assert.equal(prompts[0].input.skills[0].id, "original-skill")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("late queued cancellation cannot resurrect a closed and reused source", async () => {
  const f = await setup()
  try {
    await editQueue(f)
    await f.page.evaluate(() => { (window as any).continuations.closeA(); (window as any).continuations.reuseA(); (window as any).fixture.select("B") })
    await f.input.fill("Keep B draft")
    await f.page.evaluate(() => (window as any).continuations.releaseCancel())
    await f.page.waitForTimeout(100)
    await f.page.evaluate(() => (window as any).fixture.select("A"))
    assert.equal(await f.page.getByRole("button", { name: "Restore saved prompt", exact: true }).count(), 0)
    assert.equal(await f.page.evaluate(() => (window as any).continuations.draft()), "")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("late send refusal keeps newer text and focus with contextual polite feedback instead of a modal", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.block("instruction"))
    await f.input.fill("Attempted draft"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "instruction"))
    await f.input.fill("Newer text"); await f.page.getByLabel("Other control").fill("Working elsewhere")
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).fixture.release() })
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "Newer text")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    await f.page.getByRole("status").filter({ hasText: "remaining steps" }).waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
for (const selection of ["agent", "skill"]) for (const key of ["Enter", "Tab"]) test(`remote ${selection} filtered to one row selects with ${key}`, async () => {
  const f = await setup()
  try {
    await f.input.fill("@"); await f.page.getByText("Skill A", { exact: true }).last().waitFor()
    await f.input.press("ArrowDown")
    await f.input.fill(selection === "agent" ? "@build" : "@Skill")
    await f.input.press(key)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.attachments().map((item: any) => item.source.type)), [selection])
    assert.deepEqual(f.files, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("rotation settles the side-question owner without publishing its answer and permits an explicit new question", async () => {
  const f = await setup()
  try {
    await f.input.fill("/btw Why?"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).continuations.generates() === 1)
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).continuations.releaseGenerate(0, "Stale answer") })
    await f.page.waitForTimeout(100)
    assert.equal(await f.page.getByRole("status").filter({ hasText: "Thinking" }).count(), 0)
    assert.equal(await f.page.getByText("Stale answer", { exact: true }).count(), 0)
    await f.page.getByRole("button", { name: "Ask", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).continuations.generates() === 2)
    await f.page.evaluate(() => (window as any).continuations.releaseGenerate(1, "Fresh answer"))
    await f.page.getByText("Fresh answer", { exact: true }).waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const action of ["cancel", "close"]) test(`a retired side question cannot settle a newer request after ${action}`, async () => {
  const f = await setup()
  try {
    await f.input.fill("/btw Old question"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).continuations.generates() === 1)
    await f.page.getByRole("button", { name: action === "cancel" ? "Cancel question" : "Close side question", exact: true }).click()
    if (action === "close") {
      await f.input.fill("/btw New question"); await f.input.press("Enter")
    } else await f.page.getByRole("button", { name: "Ask", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).continuations.generates() === 2)
    await f.page.evaluate(() => (window as any).continuations.releaseGenerate(0, "Old answer"))
    await f.page.waitForTimeout(50)
    assert.equal(await f.page.getByRole("status").filter({ hasText: "Thinking" }).count(), 1)
    assert.equal(await f.page.getByText("Old answer", { exact: true }).count(), 0)
    await f.page.evaluate(() => (window as any).continuations.releaseGenerate(1, "New answer"))
    await f.page.getByText("New answer", { exact: true }).waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("an open remote picker clamps selection when its native agent catalogue shrinks", async () => {
  const f = await setup()
  try {
    await f.input.fill("@build"); await f.page.getByText("build", { exact: true }).last().waitFor()
    await f.page.evaluate(() => (window as any).continuations.agents(["build", "builder"]))
    await f.input.press("ArrowDown")
    await f.page.evaluate(() => (window as any).continuations.agents(["build"]))
    await f.input.press("Enter")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.attachments().map((item: any) => item.source.name)), ["build"])
    assert.deepEqual(f.files, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("undo acknowledgement preserves newer draft and external focus", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).continuations.seedQueued(false))
    await f.page.locator('[data-message-id="queued"][data-view="message-item"]').hover()
    await f.page.getByRole("button", { name: "Undo changes up to here (deletes messages)", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).continuations.undoStarted() === 1)
    await f.input.fill("New draft while undo waits"); await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => (window as any).continuations.releaseUndo())
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "New draft while undo waits")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const action of ["undo", "fork"]) test(`late ${action} acknowledgement cannot activate or prefill after source closure`, async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).continuations.seedQueued(false))
    await f.page.locator('[data-message-id="queued"][data-view="message-item"]').hover()
    await f.page.getByRole("button", { name: action === "undo" ? "Undo changes up to here (deletes messages)" : "Fork after this message", exact: true }).click()
    await f.page.waitForFunction(action => (window as any).continuations[action === "undo" ? "undoStarted" : "forkStarted"]() === 1, action)
    await f.page.evaluate(() => { (window as any).continuations.closeA(); (window as any).continuations.reuseA(); (window as any).fixture.select("B") })
    await f.input.fill("New B draft"); await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(action => (window as any).continuations[action === "undo" ? "releaseUndo" : "releaseFork"](), action)
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "New B draft")
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const locale of ["en", "fr", "he"] as const) test(`interrupted-action feedback preserves focus and reflows at 320 CSS pixels (${locale})`, async () => {
  const f = await setup()
  try {
    await f.page.setViewportSize({ width: 320, height: 850 })
    await f.page.evaluate(async locale => {
      document.getElementById("root")!.style.width = "100%"
      await (window as any).continuations.locale(locale)
    }, locale)
    await f.page.evaluate(() => (window as any).fixture.block("instruction"))
    await f.input.fill("Attempted draft"); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "instruction"))
    await f.page.getByLabel("Other control").focus()
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).fixture.release() })
    const notice = f.page.locator(".composer-notice[role=status]")
    await notice.waitFor()
    const box = await notice.boundingBox()
    assert.ok(box && box.width <= 320 && box.height > 30)
    assert.equal(await notice.getAttribute("aria-live"), "polite")
    assert.doesNotMatch(await notice.innerText(), /session\.actions\.interrupted/)
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "elsewhere")
    assert.equal(await f.page.evaluate(() => (window as any).continuations.alert()), null)
    if (locale === "he") assert.equal(await f.page.locator("html").getAttribute("dir"), "rtl")
    await f.page.screenshot({ path: resolve(captures, `interrupted-${locale}-320.png`) })
    assert.deepEqual(f.files, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
