import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Locator } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
      logLevel: "error", plugins: [shutdown.plugin, solid(), { name: "mission-primitives", configureServer(s) {
        s.middlewares.use("/mission-primitives", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/mission-primitives", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-primitives.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-primitives`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const longText = (label: string, length = 20000) => `${label}\n\n${Array.from({ length: 1000 }, (_, i) => `${label} paragraph ${i}.\n\n`).join("")}`.slice(0, length - `${label}_TAIL_PROOF`.length) + `${label}_TAIL_PROOF`
function mission(): MissionMap {
  return { version: 1, id: "reader", projectID: "project", projectCanonical: "/fixture", objective: longText("OBJECTIVE"), template: "custom",
    coordinatorSessionId: "coordinator", status: "active", actors: [], frontier: [], claims: [], revision: 2,
    createdAt: 1, updatedAt: 1, tasks: [], reports: [], history: [], historyTruncated: false }
}
async function setup(value = mission()) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: "en-US" }), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let current = value
  await page.addInitScript("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text}}})")
  await page.route("**/api/**", route => route.fulfill({ json: route.request().method() === "GET"
    && new URL(route.request().url()).pathname === "/workspaces/track3/instance/api/shell" ? { location: { directory: "/fixture" }, data: [] }
    : route.request().url().includes("/missions")
    ? { available: true, missions: [current], generatedAt: 1, discardedEvents: 0 }
    : route.request().method() === "PATCH" ? route.request().postDataJSON() : {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).track3))
  return { page, errors, replace: (next: MissionMap) => { current = next } }
}
const show = (page: Page, kind = "overview", itemId?: string) => page.evaluate(({ kind, itemId }) => (window as any).track3.show(kind, itemId), { kind, itemId })
async function readPages(article: Locator) {
  await article.locator(".markdown-body,pre").first().waitFor()
  await article.page().waitForFunction(() => [...document.querySelectorAll(".mission-reader .markdown-body")].some(e => Boolean(e.textContent)))
  const selector = article.getByRole("spinbutton")
  const count = await selector.count() ? Number(await selector.getAttribute("max")) : 1
  const texts: string[] = []
  for (let page = 1; page <= count; page++) {
    if (page > 1) {
      const previous = await article.locator(".markdown-body,pre").first().textContent()
      await selector.fill(String(page))
      await article.page().waitForFunction(({ previous, index }) => document.querySelectorAll(".mission-reader article")[index]?.querySelector(".markdown-body,pre")?.textContent !== previous,
        { previous, index: await article.evaluate(e => [...document.querySelectorAll(".mission-reader article")].indexOf(e)) })
    }
    texts.push(await article.locator(".markdown-body,pre").first().innerText())
  }
  return texts.join("\n")
}

test("mission reader exposes every character of valid 11010/20000-character fields while shared Markdown stays capped", async () => {
  const current = mission(), f = await setup(current)
  try {
    const functionProof = await f.page.evaluate(() => { const text = (window as any).track3.bounded("a".repeat(11000) + "TAIL_PROOF"); return { length: text.length, tail: text.includes("TAIL_PROOF") } })
    assert.deepEqual(functionProof, { length: 10000, tail: false })
    console.info("Actual shared-function proof", JSON.stringify(functionProof))
    for (const objective of ["a".repeat(11000) + "TAIL_PROOF", longText("OBJECTIVE")]) {
      current.objective = objective; f.replace({ ...current }); await show(f.page)
      const article = f.page.locator(".mission-reader article").first()
      assert((await readPages(article)).includes("TAIL_PROOF"), "real mission reader lost the valid source tail")
      await article.getByRole("button", { name: "Copy", exact: true }).click()
      await f.page.waitForFunction(text => (window as any).copiedText === text, objective)
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("long revision before/after and cumulative evidence remain reachable through bounded Markdown pages", async () => {
  const current = mission()
  current.history = [{ revision: 2, createdAt: 2, reason: "Long revision", objective: { before: longText("BEFORE"), after: longText("AFTER") }, addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }]
  current.tasks = [{ id: "task", key: "work", title: "Work", brief: longText("BRIEF"), role: "worker", status: "completed", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }]
  current.reports = [{ id: "report", taskKey: "work", sessionId: "actor", outcome: "completed", summary: "Summary", evidence: [longText("EVIDENCE1", 2000), longText("EVIDENCE2", 2000), longText("EVIDENCE3", 2000), longText("EVIDENCE4", 2000), longText("EVIDENCE5", 2000), longText("EVIDENCE6", 2000)], next: [], createdAt: 1 }]
  const f = await setup(current)
  try {
    await show(f.page, "change", "2")
    const history = f.page.locator(".mission-reader article").filter({ has: f.page.getByRole("heading", { name: "Objective", exact: true }) })
    const text = await readPages(history)
    assert(text.includes("BEFORE_TAIL_PROOF") && text.includes("AFTER_TAIL_PROOF") && text.includes("After"), "revision reader must expose its AFTER section and both tails")
    await show(f.page, "task", "task")
    assert((await readPages(f.page.locator(".mission-reader article").first())).includes("BRIEF_TAIL_PROOF"))
    await show(f.page, "report", "report")
    const evidence = f.page.locator(".mission-reader article").filter({ has: f.page.getByRole("heading", { name: "Evidence", exact: true }) })
    assert((await readPages(evidence)).includes("EVIDENCE6_TAIL_PROOF"))
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("reader pagination keeps focus, draft and transcript position; target changes reset the page", async () => {
  const f = await setup()
  try {
    await f.page.locator("#draft").fill("Unchanged composer draft")
    assert.equal(await f.page.locator("#draft").inputValue(), "Unchanged composer draft")
    await f.page.locator("#reader-trigger").focus()
    await f.page.locator("#transcript").evaluate(e => { e.scrollTop = 120 })
    await show(f.page)
    const article = f.page.locator(".mission-reader article").first(), input = article.getByRole("spinbutton")
    await input.fill("2")
    assert.equal(await input.evaluate(e => e === document.activeElement), true)
    assert.equal(await f.page.locator("#draft").inputValue(), "Unchanged composer draft")
    assert.equal(await f.page.locator("#transcript").evaluate(e => e.scrollTop), 120)
    const current = mission(); current.notes = longText("NOTES"); f.replace(current)
    await f.page.evaluate(() => (window as any).track3.refresh())
    assert.equal(await input.inputValue(), "2", "unchanged source preserves page across snapshot refresh")
    current.objective = longText("REPLACED"); f.replace({ ...current }); await f.page.evaluate(() => (window as any).track3.refresh())
    await f.page.waitForFunction(() => (document.querySelector('.mission-reader input[type="number"]') as HTMLInputElement)?.value === "1")
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).focus()
    await f.page.keyboard.press("Escape")
    await f.page.locator(".mission-reader").waitFor({ state: "detached" })
    assert.equal(await f.page.locator("#reader-trigger").evaluate(e => e === document.activeElement), true)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("raw reader pages preserve exact source and surrogate pairs without mounting the whole artifact", async () => {
  const current = mission()
  const artifact = "a".repeat(8998) + "😀" + "b".repeat(12000) + "RAW_TAIL_PROOF"
  current.reports = [{ id: "raw", taskKey: "work", sessionId: "actor", outcome: "completed", summary: "Summary", evidence: [], next: [], artifact, createdAt: 1 }]
  const f = await setup(current)
  try {
    await show(f.page, "report", "raw")
    const article = f.page.locator(".mission-reader article").filter({ has: f.page.getByRole("heading", { name: "Structured report", exact: true }) })
    const selector = article.getByRole("spinbutton"), count = Number(await selector.getAttribute("max")), pieces: string[] = []
    for (let page = 1; page <= count; page++) {
      await selector.fill(String(page))
      const text = await article.locator("pre").textContent() ?? ""
      assert(text.length <= 9001)
      assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text), "a page split a surrogate pair")
      pieces.push(text)
    }
    assert.equal(pieces.join(""), JSON.stringify(artifact, null, 2))
    await article.getByRole("button", { name: "Copy", exact: true }).click()
    await f.page.waitForFunction(source => (window as any).copiedText === source, JSON.stringify(artifact, null, 2))
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const locale of ["en", "he"] as const) test(`real RightPanel ${locale} arrows follow physical positions and preserve wrapping/Home/End`, async () => {
  const f = await setup()
  try {
    await f.page.evaluate(locale => (window as any).track3.locale(locale), locale)
    await f.page.waitForFunction(direction => document.documentElement.dir === direction, locale === "he" ? "rtl" : "ltr")
    const tabs = f.page.locator('.right-panel-tab[role="tab"]')
    await tabs.nth(1).waitFor()
    const positions = await tabs.evaluateAll(elements => elements.map(e => ({ id: e.getAttribute("data-tab-id"), x: e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2 })))
    const middle = [...positions].sort((a, b) => a.x - b.x)[1]
    for (const [key, sign] of [["ArrowLeft", -1], ["ArrowRight", 1]] as const) {
      const button = f.page.locator(`[data-tab-id="${middle.id}"]`)
      await button.focus(); await button.press(key)
      const selected = await f.page.locator('.right-panel-tab[aria-selected="true"]').getAttribute("data-tab-id")
      const destination = positions.find(p => p.id === selected)!
      console.info("Mounted physical tab proof", JSON.stringify({ locale, key, positions, from: middle, destination }))
      assert((destination.x - middle.x) * sign > 0, `${locale} ${key} moved in the opposite physical direction`)
      assert.equal(await f.page.locator(`[data-tab-id="${destination.id}"]`).evaluate(e => e === document.activeElement), true)
    }
    await tabs.nth(0).focus(); await f.page.keyboard.press(locale === "he" ? "ArrowRight" : "ArrowLeft")
    assert.equal(await tabs.last().getAttribute("aria-selected"), "true")
    await f.page.keyboard.press("Home"); assert.equal(await tabs.first().getAttribute("aria-selected"), "true")
    await f.page.keyboard.press("End"); assert.equal(await tabs.last().getAttribute("aria-selected"), "true")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("Turkish shared truncation guidance renders from the actual selected dictionary, not English fallback", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).track3.locale("tr"))
    await f.page.waitForFunction(() => document.documentElement.lang === "tr")
    await f.page.waitForFunction(() => document.getElementById("default-budget")?.textContent?.includes("tam çıktıya"), undefined, { timeout: 3000 })
    assert(!(await f.page.locator("#default-budget").innerText()).includes("Output truncated"))
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
