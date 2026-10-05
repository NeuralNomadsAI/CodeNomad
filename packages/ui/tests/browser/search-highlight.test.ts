import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, writeFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"
import { chromium, webkit, _electron, type Browser, type ElectronApplication, type Page } from "playwright"
import { startHighlightHarness, baselineCommit } from "./search-highlight-harness"

let harness: Awaited<ReturnType<typeof startHighlightHarness>>, browser: Browser, app: ElectronApplication | undefined
const memoryEvidence: unknown[] = []
let electronProfile: string | undefined
const host = process.env.CODENOMAD_HIGHLIGHT_HOST ?? "chromium"
before(async () => {
  harness = await startHighlightHarness()
  if (host === "electron") {
    electronProfile = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || os.tmpdir(), "highlight-electron-"))
    const env = { ...process.env, CODENOMAD_TEST_PROFILE: electronProfile }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON,
      args: [fileURLToPath(new URL("fixtures/tab-chrome-electron.cjs", import.meta.url))], env })
  } else browser = await (host === "webkit" ? webkit : chromium).launch({
    ...(host === "edge" ? { channel: "msedge" } : {}),
    ...(process.env.CODENOMAD_BROWSER_PATH ? { executablePath: process.env.CODENOMAD_BROWSER_PATH } : {}),
  })
})
after(async () => {
  await app?.close(); await browser?.close(); await harness?.server.close()
  if (electronProfile) await rm(electronProfile, { recursive: true, force: true, maxRetries: 3 })
})

async function open(mode: string, workload = "short") {
  const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1200, height: 850 } })
  if (app) await page.unrouteAll()
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(`${harness.url}?mode=${mode}&workload=${workload}`)
  await page.waitForFunction(() => Boolean((window as any).highlightFixture))
  await page.locator(".message-text").first().waitFor()
  // Wait for committed Markdown rather than measuring its temporary escaped-text fallback.
  await page.locator(".message-text p").first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => (window as any).highlightFixture.settle())
  return page
}
async function close(page: Page) { if (!app) await page.close() }
const snapshot = (page: Page) => page.evaluate(() => (window as any).highlightFixture.snapshot())
const change = (page: Page, query: string, occurrence: number | null = null) => page.evaluate(
  ({ query, occurrence }) => (window as any).highlightFixture.change(query, occurrence), { query, occurrence })

test("range and fallback painters preserve baseline occurrences in real messages", async () => {
  const counts: number[] = []
  for (const mode of ["baseline", "css", "fallback"]) {
    const page = await open(mode)
    try {
      await change(page, "needle")
      const state = await snapshot(page)
      assert.ok(state.matches > 0)
      assert.ok(state.texts.every((text: string) => text === "needle"))
      counts.push(state.matches)
      await change(page, "ribbon", 2)
      assert.equal((await snapshot(page)).active, 1)
      await change(page, "missing")
      assert.equal((await snapshot(page)).matches, 0)
      await change(page, "")
      assert.deepEqual((await snapshot(page)).registries, [])
    } finally { await close(page) }
  }
  assert.equal(counts[0], counts[1]); assert.equal(counts[1], counts[2])
})

test("CSS painting preserves a selection that baseline node replacement destroys", async () => {
  for (const mode of ["baseline", "css"]) {
    const page = await open(mode)
    try {
      assert.equal(await page.evaluate(() => (window as any).highlightFixture.select()), "needle")
      await change(page, "needle")
      assert.equal((await snapshot(page)).selection, mode === "css" ? "needle" : "")
    } finally { await close(page) }
  }
})

test("mounted-row ownership, unmount/remount and asynchronous replacement stay isolated", async () => {
  const page = await open("css")
  try {
    await change(page, "needle")
    const initial = await snapshot(page)
    await page.evaluate(() => (window as any).highlightFixture.rows(1))
    assert.equal((await snapshot(page)).matches, initial.matches / 2)
    await page.evaluate(() => (window as any).highlightFixture.visibility(false))
    assert.deepEqual((await snapshot(page)).registries, [])
    await page.evaluate(() => (window as any).highlightFixture.visibility(true))
    assert.equal((await snapshot(page)).matches, initial.matches / 2)
    // Simulate a committed async renderer replacement after the record effect.
    await page.locator(".message-text").first().evaluate(element => { element.textContent = "late needle needle" })
    await page.evaluate(() => (window as any).highlightFixture.settle())
    assert.equal((await snapshot(page)).matches, 2)
    assert.equal((await snapshot(page)).detached, 0)
    await page.evaluate(() => (window as any).highlightFixture.visibility(false))
    await page.evaluate(() => (window as any).highlightFixture.rows(2))
    assert.deepEqual((await snapshot(page)).registries, [])
  } finally { await close(page) }
})

test("real tool/reasoning renderers, disclosures, Unicode and fallback cleanup", async () => {
  for (const mode of ["css", "fallback"]) {
    const page = await open(mode, "mixed")
    try {
      await page.locator(".tool-call").first().waitFor()
      await change(page, "needle")
      await page.evaluate(() => (window as any).highlightFixture.settle())
      const initial = await snapshot(page)
      assert.ok(initial.matches > 24)
      await page.evaluate(() => (window as any).highlightFixture.thinking(false))
      assert.ok((await snapshot(page)).matches < initial.matches)
      await change(page, "")
      await page.evaluate(() => (window as any).highlightFixture.replace("İ needle 😀 needle שלום"))
      await change(page, "needle")
      assert.ok((await snapshot(page)).texts.every((text: string) => text === "needle"))
      await change(page, "")
      assert.equal(await page.locator("mark.session-search-match").count(), 0)
    } finally { await close(page) }
  }
})

test("native streaming events repaint committed Markdown and leave no stale ranges", async () => {
  const page = await open("css")
  try {
    await change(page, "needle")
    const before = (await snapshot(page)).matches
    await page.evaluate(() => (window as any).highlightFixture.stream("A streaming **needle** reply"))
    await page.waitForFunction(count => (window as any).highlightFixture.snapshot().matches === count + 1, before)
    await page.evaluate(() => (window as any).highlightFixture.stream(" with another needle."))
    await page.waitForFunction(count => (window as any).highlightFixture.snapshot().matches === count + 2, before)
    assert.equal((await snapshot(page)).detached, 0)
    await page.evaluate(() => (window as any).highlightFixture.visibility(false))
    assert.deepEqual((await snapshot(page)).registries, [])
  } finally { await close(page) }
})

test("literal Unicode matches, multiline content and controls share CSS/fallback semantics", async () => {
  for (const mode of ["css", "fallback"]) {
    const page = await open(mode)
    try {
      await page.evaluate(() => (window as any).highlightFixture.rows(1))
      // Replace the renderer's committed text to exercise offsets without Markdown normalization.
      await page.locator(".message-text").evaluate(element => {
        element.replaceChildren(document.createTextNode("İ needle 😀 שלום\nsecond needle [a.*]"))
        const button = document.createElement("button"); button.textContent = "needle"; element.append(button)
      })
      for (const [query, expected] of [["needle", ["needle", "needle"]], ["😀", ["😀"]], ["שלום", ["שלום"]],
        ["i", ["İ"]], ["שלום\nsecond", ["שלום\nsecond"]], ["[a.*]", ["[a.*]"]]] as const) {
        await change(page, query)
        assert.deepEqual((await snapshot(page)).texts, [...expected])
      }
      await change(page, "")
      assert.equal(await page.locator(".message-text button").textContent(), "needle")
      assert.equal(await page.locator(".message-text").textContent(), "İ needle 😀 שלום\nsecond needle [a.*]needle")
    } finally { await close(page) }
  }
})

test("repeated real component churn releases highlight registries and DOM nodes", async () => {
  const page = await open("css")
  try {
    const before = (await snapshot(page)).nodes
    for (let i = 0; i < 12; i++) {
      await change(page, i % 2 ? "needle" : "ribbon", i % 5)
      await page.evaluate(() => (window as any).highlightFixture.visibility(false))
      assert.deepEqual((await snapshot(page)).registries, [])
      await page.evaluate(() => (window as any).highlightFixture.visibility(true))
    }
    await change(page, "")
    assert.equal((await snapshot(page)).nodes, before)
  } finally { await close(page) }
})

test("expanding case folds can overlap original characters without breaking fallback painting", async () => {
  for (const mode of ["css", "fallback"]) {
    const page = await open(mode)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.evaluate(() => (window as any).highlightFixture.rows(1))
      await page.locator(".message-text").evaluate(element => { element.textContent = "İİİ" })
      await change(page, "\u0307i", 1)
      assert.equal((await snapshot(page)).active, 1)
      await change(page, "\u0307i", 0)
      const activeText = await page.evaluate(() => {
        const ranges = CSS.highlights?.get("codenomad-search-active")
        return ranges ? ([...ranges][0] as Range).toString() : document.querySelector("mark.session-search-match-active")?.textContent
      })
      assert.equal(activeText, "İİ")
      assert.equal(await page.locator(".message-text").textContent(), "İİİ")
      await change(page, "")
      assert.equal(await page.locator("mark.session-search-match").count(), 0)
      assert.equal(await page.locator(".message-text").textContent(), "İİİ")
      assert.deepEqual(errors, [])
    } finally { await close(page) }
  }
})

test("light/dark and fractional zoom keep active highlight distinct without layout changes", async () => {
  const page = await open("css")
  try {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => (window as any).highlightFixture.theme(theme), theme)
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
      await page.evaluate(() => { document.body.style.zoom = "1.25" })
      await change(page, "")
      const before = await page.locator(".message-text").first().boundingBox()
      await change(page, "needle", 0)
      assert.deepEqual(await page.locator(".message-text").first().boundingBox(), before)
      const colors = await page.locator(".message-text").first().evaluate(element => ({
        normal: getComputedStyle(element, "::highlight(codenomad-search)").backgroundColor,
        active: getComputedStyle(element, "::highlight(codenomad-search-active)").backgroundColor,
      }))
      assert.notEqual(colors.normal, colors.active)
      if (process.env.CODENOMAD_HIGHLIGHT_CAPTURES) {
        await mkdir(process.env.CODENOMAD_HIGHLIGHT_CAPTURES, { recursive: true })
        await page.screenshot({ path: join(process.env.CODENOMAD_HIGHLIGHT_CAPTURES, `${host}-${theme}-125.png`) })
      }
    }
  } finally { await close(page) }
})

test("active occurrences are revealed inside nested scrolling content without mark padding reflow", async () => {
  const page = await open("css", "long")
  try {
    const before = await page.locator(".message-text").first().evaluate(element => element.getBoundingClientRect().height)
    await change(page, "needle")
    assert.equal(await page.locator(".message-text").first().evaluate(element => element.getBoundingClientRect().height), before)
    await page.locator(".message-text").first().evaluate((element: HTMLElement) => {
      element.style.height = "250px"; element.style.overflow = "auto"
    })
    // The real Markdown renderer caps displayed content at 10,000 characters.
    // Target a rendered occurrence, not one beyond that existing display cap.
    await change(page, "needle", 40)
    const geometry = await page.evaluate(() => {
      const range = [...CSS.highlights.get("codenomad-search-active")!][0] as Range
      const rect = range.getBoundingClientRect()
      const element = document.querySelector<HTMLElement>(".message-text")!
      const bounds = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, boundsTop: bounds.top, boundsBottom: bounds.bottom, scrollTop: element.scrollTop }
    })
    assert.ok(geometry.scrollTop > 0)
    assert.ok(geometry.top >= geometry.boundsTop && geometry.bottom <= geometry.boundsBottom, JSON.stringify(geometry))
  } finally { await close(page) }
})

test("Chromium GC counters remain bounded after repeated search owner disposal", { skip: host === "webkit" }, async () => {
  for (const mode of ["baseline", "css"]) {
    const page = await open(mode)
    const cdp = await page.context().newCDPSession(page)
    try {
      // Warm the real component caches before comparing retained DOM counts.
      await change(page, "needle")
      await page.evaluate(() => (window as any).highlightFixture.visibility(false))
      await page.evaluate(() => (window as any).highlightFixture.visibility(true))
      await change(page, "")
      await cdp.send("HeapProfiler.collectGarbage")
      const before = await cdp.send("Memory.getDOMCounters")
      for (let i = 0; i < 16; i++) {
        await change(page, i % 2 ? "ribbon" : "needle")
        await page.evaluate(() => (window as any).highlightFixture.visibility(false))
        await page.evaluate(() => (window as any).highlightFixture.visibility(true))
      }
      await change(page, "")
      await cdp.send("HeapProfiler.collectGarbage")
      const after = await cdp.send("Memory.getDOMCounters")
      memoryEvidence.push({ mode, cycles: 16, before, after })
      assert.ok(after.nodes <= before.nodes + 32, `${mode}: retained nodes ${before.nodes} -> ${after.nodes}`)
      assert.deepEqual((await snapshot(page)).registries, [])
    } finally { await cdp.detach(); await close(page) }
  }
})

test("alternating before/after benchmark on identical rendered transcripts", {
  skip: !process.env.CODENOMAD_HIGHLIGHT_RESULTS, timeout: 240_000,
}, async () => {
  const results: unknown[] = []
  const versions = app ? await app.evaluate(() => process.versions) : { browser: browser.version() }
  for (const workload of ["short", "long", "dense", "mixed", "sparse", "missing"]) {
    // Keep only one visible renderer when using Electron; alternate reloads in
    // small blocks there. Browser variants get their own pages and alternate.
    const pages = new Map<string, Page>()
    if (!app) for (const mode of ["baseline", "css"]) pages.set(mode, await open(mode, workload))
    try {
      for (let block = 0; block < 6; block++) {
        const order = block % 2 ? ["css", "baseline"] : ["baseline", "css"]
        for (const mode of order) {
          const page = app ? await open(mode, workload) : pages.get(mode)!
          await page.bringToFront()
          for (let warm = 0; warm < 3; warm++) await page.evaluate(value => (window as any).highlightFixture.trial(value), warm % 2 ? "needle" : "ribbon")
          for (let trial = 0; trial < 5; trial++) {
            const sample = await page.evaluate(value => (window as any).highlightFixture.trial(value), trial % 2 ? "ribbon" : "needle")
            results.push({ host, block, trial, ...sample })
          }
        }
      }
      if (process.env.CODENOMAD_HIGHLIGHT_CAPTURES) {
        await mkdir(process.env.CODENOMAD_HIGHLIGHT_CAPTURES, { recursive: true })
        for (const mode of ["baseline", "css"]) {
          const page = app ? await open(mode, workload) : pages.get(mode)!
          await change(page, "needle", 0)
          await page.screenshot({ path: join(process.env.CODENOMAD_HIGHLIGHT_CAPTURES, `${host}-${workload}-${mode}.png`) })
        }
      }
    } finally { for (const page of pages.values()) await close(page) }
  }
  const path = process.env.CODENOMAD_HIGHLIGHT_RESULTS!
  await mkdir(dirname(path), { recursive: true })
  const sourceHashes = Object.fromEntries(await Promise.all([
    "src/components/search-highlights.ts", "src/components/search-highlight-ranges.ts", "src/components/search-highlight-marks.ts", "src/components/message-block.tsx",
    "src/styles/messaging/search-highlights.css", "tests/browser/fixtures/search-highlight.tsx",
    "tests/browser/fixtures/search-highlight-baseline.ts", "tests/browser/fixtures/search-highlight-adapter.ts",
  ].map(async path => [path, createHash("sha256").update((await readFile(new URL(`../../${path}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n")).digest("hex")])))
  await writeFile(path, JSON.stringify({ baselineCommit, versions, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model,
    sourceHashes,
    build: process.env.CODENOMAD_HIGHLIGHT_PRODUCTION ? "production" : "development",
    memoryEvidence,
    metric: "synchronousMs = instrumented apply+cleanup; paintOpportunityMs = update to second subsequent rAF (paint opportunity, not GPU presentation)", results }, null, 2))
  console.log(`Highlight measurements: ${path}`)
})
