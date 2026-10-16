import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "mission-session-fixture", configureServer(s) {
      s.middlewares.use("/mission-session-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-session-fixture", '<html><body><div id="root" style="display:flex;height:100vh"></div><script type="module" src="/tests/browser/fixtures/mission-session.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-session-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(missions: unknown[]) {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1000, height: 800 } })
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(90_000)
  page.on("pageerror", error => console.error("fixture error", error))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/api/workspaces/browser-instance/missions", route => route.fulfill({ json: { available: true, missions, generatedAt: 1, discardedEvents: 0 } }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return page
}
/** Waits until the latest history row is painted inside the stream viewport. */
const latestHistoryPainted = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll(".message-stream p")].some(el => {
  const r = el.getBoundingClientRect(), box = document.querySelector(".message-stream")!.getBoundingClientRect()
  return el.textContent === "History 59" && r.height > 0 && r.top < box.bottom && r.bottom > box.top
}))

test("a reader for a Mission absent from the loaded map releases the transcript instead of hiding it", async () => {
  const page = await open([])
  try {
    await page.evaluate(() => (window as any).fixture.seedHistory())
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.waitForFunction(() => !document.querySelector(".mission-reader")
      && !document.querySelector(".mission-transcript-content")?.hasAttribute("inert"))
    assert.equal(await page.locator(".mission-transcript-content").evaluate(el => getComputedStyle(el).visibility), "visible")
    // The released transcript paints its latest row within a few frames.
    await latestHistoryPainted(page)
  } finally { await page.close() }
})

const readerMission = { version: 1, id: "reader", projectID: "project", projectCanonical: "/fixture", objective: "Objective", template: "custom",
  coordinatorSessionId: "ses_fixture", status: "active", actors: [], frontier: [], claims: [], revision: 1, createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
  tasks: [{ id: "task", key: "task-one", title: "Inspect", brief: "Brief", role: "research", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
  reports: [{ id: "report-reader", taskKey: "task-one", sessionId: "ses_fixture", outcome: "completed", summary: "Report opening paragraph.", evidence: [], next: [], createdAt: 1 }] }

test("history loaded beneath a reader is followed to its latest message once the reader closes", async () => {
  const page = await open([readerMission])
  try {
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.seedHistory())
    assert.equal(await page.locator(".mission-transcript-content").getAttribute("inert"), "")
    // The hidden transcript stays put; it is followed only once it can be read.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
    assert.equal(await page.locator(".message-stream").evaluate(el => el.scrollTop), 0)
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await latestHistoryPainted(page)
  } finally { await page.close() }
})

// The transcript's own restore is the only activation path to its bottom.
// SessionView stays mounted across activation, as in the instance shell.
test("a session reactivated beneath a reader is restored to its latest message once the reader closes", async () => {
  const page = await open([readerMission])
  try {
    await page.evaluate(() => (window as any).fixture.seedHistory())
    await latestHistoryPainted(page)
    await page.evaluate(() => (window as any).fixture.readMission())
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.setActive(false))
    await page.locator(".mission-transcript-content").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.setActive(true))
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-transcript-content").getAttribute("inert"), "")
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await latestHistoryPainted(page)
    // The persisted position still describes a following reader at the bottom
    // (recorded before the reader opened and on unmount, not by this restore).
    await page.waitForFunction(() => {
      const scroll = (window as any).fixture.snapshot().scroll
      return scroll?.atBottom === true && scroll.followModeType === "following"
    })
  } finally { await page.close() }
})

/** Streams `count` inline tokens, one per frame; the reply stays shorter than a held one. */
const streamDeltas = (page: Page, from: number, count: number) => page.evaluate(async ({ from, count }) => {
  for (let i = from; i < from + count; i++) {
    (window as any).fixture.delta(`token ${i} `)
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
}, { from, count })
const waitFrames = (page: Page, count: number) => page.evaluate(async count => {
  for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve))
}, count)
const streamPosition = (page: Page) => page.locator(".message-stream").evaluate(el => ({
  mode: el.getAttribute("data-follow-mode"), gap: el.scrollHeight - el.scrollTop - el.clientHeight,
}))

test("a reader opened while a following transcript streams resumes following once it closes", async () => {
  const page = await open([readerMission])
  try {
    await page.evaluate(() => (window as any).fixture.loadMissions())
    await page.evaluate(() => (window as any).fixture.seedHistory())
    await latestHistoryPainted(page)
    // The opening restore has settled and recorded a following reader.
    await page.waitForFunction(() => (window as any).fixture.snapshot().scroll?.followModeType === "following")
    await page.evaluate(() => (window as any).fixture.startStream())
    await streamDeltas(page, 0, 10)
    await page.waitForFunction(() => {
      const el = document.querySelector(".message-stream")!
      return el.getAttribute("data-follow-mode") === "following" && el.scrollHeight - el.scrollTop - el.clientHeight <= 1
    })
    // A multi-paragraph delta grows the reply beyond the follow tolerance. Open
    // the reader after its frame pins the bottom in the DOM, before the scroll
    // event updates Virtua's offset: the deactivation capture must still record
    // a reader at the bottom.
    await page.evaluate(async () => {
      (window as any).fixture.delta("\n\nA streamed paragraph.".repeat(4) + "\n\n")
      await new Promise(resolve => requestAnimationFrame(resolve))
      await new Promise(resolve => setTimeout(resolve))
      await (window as any).fixture.readMission()
    })
    await page.locator(".mission-reader").getByText("Report opening paragraph.", { exact: true }).waitFor()
    await streamDeltas(page, 11, 15)
    await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    await waitFrames(page, 30)
    const restored = await streamPosition(page)
    const persisted = await page.evaluate(() => JSON.stringify((window as any).fixture.snapshot().scroll))
    assert.equal(restored.mode, "following", `restored from ${persisted}`)
    assert.ok(restored.gap <= 1, `restored ${restored.gap}px above the bottom`)
    await streamDeltas(page, 26, 5)
    await waitFrames(page, 5)
    const followed = await streamPosition(page)
    assert.equal(followed.mode, "following")
    assert.ok(followed.gap <= 1, `followed ${followed.gap}px above the bottom`)
  } finally { await page.close() }
})
