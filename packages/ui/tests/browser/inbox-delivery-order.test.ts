import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"

// Another client's prompts reach this page through the session inbox: the
// engine parks each prompt on enqueue, admits it on delivery, and the native
// page owns the delivered prompt's position. These runs drive the daemon's
// real event order through the real SessionView and native dispatcher.

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "inbox-delivery-order", routes: [{
    path: "/fixture",
    html: '<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/session.tsx"></script></body></html>',
  }] })
  url = fixture.url
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
    events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    ready = true
  }, diagnose: async () => {}, cleanup: async () => {
    if (!ready) { try { await browser?.close() } finally { await events?.close() } }
  }, onObservationError: () => console.error("delivery-order-startup-observation-failed"), onCleanupError: () => console.error("delivery-order-startup-cleanup-failed") })
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`) })
  // The receipts cache aborts an in-flight read exactly when a newer read for
  // the same message supersedes it; an abort with no successor is a failure.
  let requestSequence = 0
  const receiptsReads = new Map<string, number[]>()
  const abortedReceipts: Array<{ marker: string; seq: number; message: string }> = []
  page.on("request", request => {
    const url = new URL(request.url())
    if (!url.pathname.endsWith("/permission-receipts")) return
    const marker = url.searchParams.get("messageId") ?? ""
    const seq = ++requestSequence
    receiptsReads.set(marker, [...receiptsReads.get(marker) ?? [], seq])
  })
  page.on("requestfailed", request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith("/permission-receipts") && request.failure()?.errorText === "net::ERR_ABORTED") {
      abortedReceipts.push({ marker: url.searchParams.get("messageId") ?? "", seq: ++requestSequence, message: `request failed: ${request.url()} net::ERR_ABORTED` })
      return
    }
    errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`)
  })
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/permission-receipts")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ receipts: [] }) })
    }
    return route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" })
  })
  await page.route("**/workspaces/browser-instance/yolo/sessions/browser-session", route =>
    route.request().method() === "GET" ? route.fulfill({ json: { enabled: false } }) : route.continue())
  await events.route(page)
  await runWithDiagnosticCleanup({
    run: async () => {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      await run(page)
      for (const abort of abortedReceipts) {
        const superseded = (receiptsReads.get(abort.marker) ?? []).some(seq => seq > abort.seq)
        if (!superseded) errors.push(abort.message)
      }
      assert.deepEqual(errors, [])
    },
    diagnose: async () => {
      console.error("Browser fixture failure", await page.evaluate(() => ({
        state: (window as any).fixture?.snapshot?.(),
      })))
    },
    cleanup: () => page.close(),
    onObservationError: error => console.error("Browser fixture diagnostic capture failed", error),
    onCleanupError: error => console.error("Browser fixture cleanup failed", error),
  })
}

/** DOM order of the transcript rows, as the reader sees them. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".message-stream-block"))
    .map(row => row.textContent ?? ""))
}

/** The prompt-queue action row shows while the engine still holds the prompt parked. */
function pendingActions(page: Page, marker: string) {
  return page.locator(".message-stream-block").filter({ hasText: marker })
    .locator('button[aria-label="Move to queue"], button[aria-label="Steer now"]')
}

async function assertOrder(page: Page, expected: string[]) {
  const rows = await rowOrder(page)
  let cursor = 0
  for (const marker of expected) {
    const index = rows.slice(cursor).findIndex(row => row.includes(marker))
    assert.ok(index >= 0, `${marker} must render after the previous marker (rows: ${JSON.stringify(rows.map(row => row.slice(0, 30)))})`)
    cursor += index
  }
}

test("another client's prompt renders above the reply the engine starts for it", async () => {
  await open(async page => {
    const marker = "Prompt from the other terminal"
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_remote", text), marker)
    await pendingActions(page, marker).first().waitFor()
    await page.evaluate(() => (window as any).fixture.remoteDeliver("msg_remote"))
    await pendingActions(page, marker).waitFor({ state: "detached", timeout: 3000 })
    const reply = "Reply marker for the admitted prompt"
    await page.evaluate(reply => { (window as any).fixture.startStored(); (window as any).fixture.deltaStored(reply) }, reply)
    await page.locator(".message-stream-block").filter({ hasText: reply }).waitFor()
    await assertOrder(page, [marker, reply])
  })
})

test("a steer burst delivered while parked keeps the native page order", async () => {
  await open(async page => {
    const first = "Burst steer one", second = "Burst steer two", third = "Burst steer three"
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_b1", text), first)
    await pendingActions(page, first).first().waitFor()
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_b2", text), second)
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_b3", text), third)
    for (const id of ["msg_b1", "msg_b2", "msg_b3"]) {
      await page.evaluate(id => (window as any).fixture.remoteDeliver(id), id)
    }
    await pendingActions(page, third).waitFor({ state: "detached", timeout: 3000 })
    const reply = "Reply marker after the burst"
    await page.evaluate(reply => { (window as any).fixture.startStored(); (window as any).fixture.deltaStored(reply) }, reply)
    await page.locator(".message-stream-block").filter({ hasText: reply }).waitFor()
    await assertOrder(page, [first, second, third, reply])
  })
})

test("a steer admitted mid-stream settles after the earlier reply, per the native page", async () => {
  await open(async page => {
    const earlier = "Earlier reply still streaming"
    await page.evaluate(reply => { (window as any).fixture.startStored(); (window as any).fixture.deltaStored(reply) }, earlier)
    await page.locator(".message-stream-block").filter({ hasText: earlier }).waitFor()
    const marker = "Steer admitted mid-stream"
    await page.evaluate(text => (window as any).fixture.remoteEnqueue("msg_mid", text), marker)
    await pendingActions(page, marker).first().waitFor()
    await page.evaluate(() => (window as any).fixture.remoteDeliver("msg_mid"))
    await pendingActions(page, marker).waitFor({ state: "detached", timeout: 3000 })
    await assertOrder(page, [earlier, marker])
  })
})
