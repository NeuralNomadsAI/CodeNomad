import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"
import { createFixtureCache } from "./fixture-cache"

// The real Files panel and Changes hook over a ~2,700-file inventory (the
// production freeze had 2,680): bounded sections, refreshes that reuse rows,
// and every interaction still working around the bound.
let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>

const STAGED = 700, TOTAL = 2700, BOUND = 200
// Unstaged rows: every tenth staged file's worktree side, then 2,000 unstaged-only files.
const UNSTAGED = STAGED / 10 + TOTAL - STAGED
const pathAt = (index: number) => `packages/app/src/module-${String(index).padStart(4, "0")}.ts`
// Most changed, hence auto-selected, and far beyond the unstaged bound.
const MOST_CHANGED = 2500

// Timings run from the status response to the end of its synchronous work and of the following frame.
type Measure = { added: number; removed: number; attributes: number; longTaskMs: number; scriptMs?: number; frameMs?: number; nodes: number; rows: number }

// Plain page script: tsx would wrap named page functions in an undefined `__name`.
const inventoryScript = String.raw`(async () => {
  const { serverApi } = await import("/src/lib/api-client.ts")
  const fixture = window.fixture
  const scale = window.gitScale = { calls: 0, responded: 0, scriptDone: 0, frameDone: 0 }
  scale.entries = Array.from({ length: ${TOTAL} }, (_, index) => ({
    path: "packages/app/src/module-" + String(index).padStart(4, "0") + ".ts", originalPath: null,
    stagedStatus: index < ${STAGED} ? "modified" : null, stagedAdditions: index < ${STAGED} ? 3 : 0, stagedDeletions: index < ${STAGED} ? 1 : 0,
    unstagedStatus: index >= ${STAGED} || index % 10 === 0 ? "modified" : null,
    unstagedAdditions: index === ${MOST_CHANGED} ? 9999 : index % 50, unstagedDeletions: index % 7,
  }))
  // Every read answers fresh objects, like a real response; timers record when
  // the synchronous work it triggers, and the following frame, complete.
  serverApi.fetchWorktreeGitStatus = async (_id, slug) => {
    scale.calls++
    fixture.calls.push({ kind: "status", slug })
    scale.responded = performance.now()
    setTimeout(() => { scale.scriptDone = performance.now() }, 0)
    requestAnimationFrame(() => setTimeout(() => { scale.frameDone = performance.now() }, 0))
    return scale.entries.map(entry => ({ ...entry }))
  }
  const move = kind => async (_id, slug, input) => {
    fixture.calls.push({ kind, slug, path: input.paths.join(",") })
    scale.entries = scale.entries.map(entry => !input.paths.includes(entry.path) ? entry : kind === "stage"
      ? { ...entry, stagedStatus: "modified", stagedAdditions: 3, unstagedStatus: null }
      : { ...entry, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0, unstagedStatus: "modified" })
    return { ok: true }
  }
  serverApi.stageWorktreeGitPaths = move("stage")
  serverApi.unstageWorktreeGitPaths = move("unstage")
  // DOM nodes added/removed and attribute changes in the Changes body, plus main-thread long tasks.
  scale.measure = async (action, waitForStatus = true) => {
    const body = document.querySelector(".git-drop-zone").closest(".git-panel-body")
    const counts = { added: 0, removed: 0, attributes: 0, longTaskMs: 0 }
    const size = node => node instanceof Element ? 1 + node.getElementsByTagName("*").length : 1
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.type === "attributes") counts.attributes++
      record.addedNodes.forEach(node => { counts.added += size(node) })
      record.removedNodes.forEach(node => { counts.removed += size(node) })
    }))
    observer.observe(body, { childList: true, subtree: true, attributes: true, characterData: true })
    const longTasks = new PerformanceObserver(list => list.getEntries().forEach(entry => { counts.longTaskMs += entry.duration }))
    longTasks.observe({ type: "longtask" })
    const calls = scale.calls
    scale.frameDone = 0
    action()
    while (waitForStatus && (scale.calls === calls || scale.frameDone === 0)) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 300))
    observer.disconnect()
    longTasks.disconnect()
    const timing = waitForStatus ? { scriptMs: Math.round(scale.scriptDone - scale.responded), frameMs: Math.round(scale.frameDone - scale.responded) } : {}
    return { ...counts, longTaskMs: Math.round(counts.longTaskMs), ...timing, nodes: document.getElementsByTagName("*").length,
      rows: document.querySelectorAll(".git-change-section .git-panel-file-row").length }
  }
  fixture.invalidate()
})()`

async function openLargeInventory(page: Page) {
  await page.goto(url)
  await page.waitForFunction(() => (window as any).fixture)
  await page.evaluate(inventoryScript)
  await page.getByRole("button", { name: "Changements", exact: true }).click()
  await row(page, 1, pathAt(MOST_CHANGED)).waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".files-header-icon-button")?.disabled)
}

const section = (page: Page, index: 0 | 1) => page.locator(".git-change-section").nth(index)
const rows = (page: Page, index: 0 | 1) => section(page, index).locator(".git-panel-file-row")
const row = (page: Page, index: 0 | 1, path: string) => section(page, index).locator(`.git-panel-file-main[title="${path}"]`)
const showMore = (page: Page) => section(page, 1).getByRole("button", { name: "Afficher 200 de plus", exact: true })
const refresh = (page: Page, change?: string): Promise<Measure> => page.evaluate(change => (window as any).gitScale.measure(() => {
  const scale = (window as any).gitScale
  if (change) scale.entries = scale.entries.map((entry: any) => entry.path === change ? { ...entry, unstagedAdditions: entry.unstagedAdditions + 1 } : entry)
  ;(window as any).fixture.invalidate()
}), change)
const calls = (page: Page, kind: string) => page.evaluate(kind => (window as any).fixture.calls.filter((call: any) => call.kind === kind).map((call: any) => call.path), kind)

before(async () => {
  prepareGitPrototypeAssets()
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    publicDir: fileURLToPath(new URL("../../src/renderer/public", import.meta.url)),
    plugins: [solid(), { name: "git-changes-scale-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/git-history.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

test("large inventories render bounded sections and refreshes only touch changed rows", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    const counts = await page.locator(".git-change-section-count").allTextContents()
    console.log(`Initial ${TOTAL} entries: ${JSON.stringify({ staged: await rows(page, 0).count(), unstaged: await rows(page, 1).count(),
      nodes: await page.evaluate(() => document.getElementsByTagName("*").length) })}`)
    const identical = await refresh(page)
    console.log(`Identical refresh: ${JSON.stringify(identical)}`)
    const changed = await refresh(page, pathAt(STAGED + 5))
    console.log(`One-entry refresh: ${JSON.stringify(changed)}`)
    const click: Measure = await page.evaluate(path => (window as any).gitScale.measure(() =>
      document.querySelectorAll(".git-change-section")[1].querySelector<HTMLButtonElement>(`.git-panel-file-main[title="${path}"]`)!.click(), false), pathAt(STAGED + 6))
    console.log(`Row selection click: ${JSON.stringify(click)}`)
    const rowNodes = await rows(page, 1).first().evaluate(element => 1 + element.getElementsByTagName("*").length)

    assert.deepEqual(counts, [String(STAGED), String(UNSTAGED)], "headers keep the full totals")
    assert.equal(await rows(page, 0).count(), BOUND)
    assert.equal(await section(page, 0).locator(".git-change-hidden-rows-label").textContent().then(text => text?.replace(/\D/g, "")), String(STAGED - BOUND))
    assert.deepEqual({ added: identical.added, removed: identical.removed, attributes: identical.attributes }, { added: 0, removed: 0, attributes: 0 },
      "an identical refresh publishes nothing")
    assert.deepEqual({ added: changed.added, removed: changed.removed }, { added: rowNodes, removed: rowNodes }, "only the changed row is replaced")
    assert.equal(await row(page, 1, pathAt(STAGED + 5)).locator("small").textContent(), `+${((STAGED + 5) % 50) + 1} −${(STAGED + 5) % 7}`)
    assert.equal(click.added + click.removed, rowNodes, "selecting another row only drops the auto-selected row rendered beyond the bound")
    assert.ok(click.attributes <= 6, `selection updates only the two affected rows (${click.attributes} attribute changes)`)
    assert.equal(await row(page, 1, pathAt(STAGED + 6)).getAttribute("aria-current"), "true")
  } finally { await page.close() }
})

test("a selected row beyond the bound is rendered; Show more moves focus to its first revealed row", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    assert.equal(await rows(page, 1).count(), BOUND + 1, "the auto-selected most-changed row joins the bounded rows")
    assert.equal(await row(page, 1, pathAt(MOST_CHANGED)).getAttribute("aria-current"), "true")
    assert.equal(await section(page, 1).locator(".git-change-hidden-rows-label").textContent().then(text => text?.replace(/\D/g, "")), String(UNSTAGED - BOUND - 1))
    if (process.env.CODENOMAD_GIT_CAPTURE) {
      await showMore(page).scrollIntoViewIfNeeded()
      await page.locator("aside").screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/changes-bounded.png` })
    }
    await showMore(page).focus()
    await page.keyboard.press("Enter")
    assert.equal(await rows(page, 1).count(), 2 * BOUND + 1)
    const unstagedPaths = Array.from({ length: STAGED / 10 }, (_, index) => pathAt(index * 10))
      .concat(Array.from({ length: TOTAL - STAGED }, (_, index) => pathAt(STAGED + index)))
    const focused = () => page.evaluate(() => {
      const active = document.activeElement
      return [active?.getAttribute("title"), active?.closest(".git-panel-file-row")?.previousElementSibling?.querySelector(".git-panel-file-main")?.getAttribute("title")]
    })
    assert.deepEqual(await focused(), [unstagedPaths[BOUND], unstagedPaths[BOUND - 1]], "focus lands on the first revealed row, right after the previous batch")
    const identical = await refresh(page)
    assert.equal(identical.added + identical.removed, 0)
    assert.equal(await rows(page, 1).count(), 2 * BOUND + 1, "the reveal survives refreshes")
    // A worktree change resets the reveal.
    const reads = await page.evaluate(() => (window as any).gitScale.calls)
    const selector = page.getByRole("combobox", { name: "Worktree à consulter" })
    await selector.selectOption("review")
    await page.waitForFunction(reads => (window as any).gitScale.calls > reads, reads)
    await selector.selectOption("root")
    await page.waitForFunction(reads => (window as any).gitScale.calls > reads + 1, reads)
    await row(page, 1, pathAt(MOST_CHANGED)).waitFor()
    assert.equal(await rows(page, 1).count(), BOUND + 1)
  } finally { await page.close() }
})

test("ranges, staging, previews and drag keep working around the bound", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    // A range across sections spans the rendered rows only, never the staged rows hidden beyond the bound.
    await row(page, 0, pathAt(191)).click()
    await row(page, 1, pathAt(20)).click({ modifiers: ["Shift"] })
    assert.equal(await page.locator(".git-change-section .git-panel-file-main[aria-pressed='true']").count(), 9 + 3)
    await page.locator(".git-panel-more").filter({ hasText: "Désindexer les 9 fichiers sélectionnés" }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "unstage"))
    assert.deepEqual(await calls(page, "unstage"), [Array.from({ length: 9 }, (_, index) => pathAt(191 + index)).join(",")])

    // Staging an eye-opened file moves its preview to a staged row sorted beyond the bound; it stays rendered.
    const moved = pathAt(STAGED + 5)
    await page.getByRole("button", { name: `Aperçu du fichier · ${moved}`, exact: true }).click()
    await page.getByRole("button", { name: `Indexer le fichier · ${moved}`, exact: true }).click()
    await page.waitForFunction(path => (window as any).fixture.target()?.scope === "staged" && (window as any).fixture.target()?.path === path, moved)
    await row(page, 0, moved).waitFor()
    assert.equal(await rows(page, 0).count(), BOUND + 1)
    assert.equal(await section(page, 0).getByRole("button", { name: `Aperçu du fichier · ${moved}`, exact: true }).getAttribute("aria-pressed"), "true")

    // Drag an unstaged row near the top of its section onto the collapsed staged header.
    await section(page, 0).locator(".git-change-section-header").click()
    const dragged = pathAt(30)
    const { source, target } = await page.evaluate(dragged => {
      const sections = document.querySelectorAll(".git-change-section")
      return Object.fromEntries(([["source", sections[1].querySelector(`.git-panel-file-main[title="${dragged}"]`)],
        ["target", sections[0].querySelector(".git-change-section-header")]] as const).map(([key, element]) => {
        element?.scrollIntoView({ block: "nearest" })
        const box = element?.getBoundingClientRect()
        return [key, box && box.width > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null]
      }))
    }, dragged)
    assert.ok(source && target)
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 10, { steps: 4 })
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(path => (window as any).fixture.calls.some((call: any) => call.kind === "stage" && call.path === path), dragged)
  } finally { await page.close() }
})
