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
type Measure = { added: number; removed: number; attributes: number; rowAttributes: number; longTaskMs: number; scriptMs?: number; frameMs?: number; nodes: number; rows: number }

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
    const counts = { added: 0, removed: 0, attributes: 0, rowAttributes: 0, longTaskMs: 0 }
    const size = node => node instanceof Element ? 1 + node.getElementsByTagName("*").length : 1
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.type === "attributes") {
        counts.attributes++
        if (record.target.closest(".git-panel-file-row")) counts.rowAttributes++
      }
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
    assert.equal(click.added + click.removed, 0, "selecting another row adds or removes no row: the auto-selected row beyond the bound is sticky")
    assert.equal(click.rowAttributes, 6, "selection updates class, aria-pressed and aria-current of the two affected rows only")
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

// Focus-sensitive checks use real keyboard and mouse input: scripted focus skips
// the focusout/focusin sequence a real move goes through.
const active = (page: Page) => page.evaluate(() => {
  const element = document.activeElement
  return { tag: element?.tagName, name: element?.tagName !== "BUTTON" ? null
    : element.classList.contains("git-change-section-header") ? "header" : element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent,
  section: Array.from(document.querySelectorAll(".git-change-section")).findIndex(section => section.contains(element)) }
})
const stagedMore = { tag: "BUTTON", name: "Afficher 200 de plus", section: 0 }
const eye = (page: Page, index: 0 | 1, path: string) => section(page, index).getByRole("button", { name: `Aperçu du fichier · ${path}`, exact: true })
const updateEntries = (page: Page, script: string) => page.evaluate(script => (window as any).gitScale.measure(() => {
  const scale = (window as any).gitScale
  scale.entries = new Function("entries", script)(scale.entries)
  ;(window as any).fixture.invalidate()
}), script)
// Preview an unstaged file and stage it: its staged row sorts beyond the bound, pinned by the preview.
async function pinStaged(page: Page, path: string) {
  await eye(page, 1, path).click()
  await page.getByRole("button", { name: `Indexer le fichier · ${path}`, exact: true }).click()
  await page.waitForFunction(path => (window as any).fixture.target()?.scope === "staged" && (window as any).fixture.target()?.path === path, path)
  await row(page, 0, path).waitFor()
}

test("a row shown beyond the bound stays for real keyboard, mouse and menu use after its preview closes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    // The reported repro: staged #701 is pinned only by its preview; the current row stays module-2500.
    const previewed = pathAt(STAGED + 5)
    await pinStaged(page, previewed)
    assert.equal(await rows(page, 0).count(), BOUND + 1)
    assert.equal(await row(page, 1, pathAt(MOST_CHANGED)).getAttribute("aria-current"), "true")
    await eye(page, 0, previewed).focus() // setup only: reach the eye without selecting the row
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => !(window as any).fixture.target())
    assert.equal(await eye(page, 0, previewed).getAttribute("aria-pressed"), "false")
    assert.equal(await rows(page, 0).count(), BOUND + 1, "closing its preview keeps the row")
    assert.deepEqual(await active(page), { tag: "BUTTON", name: `Aperçu du fichier · ${previewed}`, section: 0 })
    await page.keyboard.press("Tab")
    assert.deepEqual(await active(page), { tag: "BUTTON", name: `Retirer de l'index · ${previewed}`, section: 0 })
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Shift+Tab")
    assert.deepEqual(await active(page), { tag: "BUTTON", name: previewed, section: 0 })
    for (let step = 0; step < 3; step++) await page.keyboard.press("Tab")
    assert.deepEqual(await active(page), stagedMore, "Tab leaves the row for Show more")
    assert.equal(await rows(page, 0).count(), BOUND + 1, "focus leaving never removes it")

    // A real click selects it; the previous current row stays rendered as well.
    await row(page, 0, previewed).click()
    assert.equal(await row(page, 0, previewed).getAttribute("aria-current"), "true")
    assert.deepEqual(await active(page), { tag: "BUTTON", name: previewed, section: 0 })
    assert.equal(await row(page, 1, pathAt(MOST_CHANGED)).count(), 1)

    // Compact layout: the row's … menu opens and its stage action works; focus then moves to Show more.
    await page.locator("aside").evaluate(element => { element.style.width = "160px"; element.style.minWidth = "0"; element.style.maxWidth = "none" })
    const actions = section(page, 0).locator(`.git-panel-file-row[data-git-item-id="staged:${previewed}"] .file-row-actions`)
    await row(page, 0, previewed).hover()
    await page.waitForFunction(path => document.querySelector(`[data-git-item-id="staged:${path}"] .file-row-actions`)?.getAttribute("data-compact") === "true", previewed)
    await actions.locator(".action-overflow-trigger").click()
    await page.getByRole("menuitem", { name: `Retirer de l'index · ${previewed}` }).click()
    await page.waitForFunction(path => (window as any).fixture.calls.some((call: any) => call.kind === "unstage" && call.path === path), previewed)
    await row(page, 0, previewed).waitFor({ state: "detached" })
    assert.deepEqual(await active(page), stagedMore)
  } finally { await page.close() }
})

test("a focused row that leaves the list hands focus to a neighbour row or the section, never the commit box", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    // A refresh changing the clicked row keeps focus on its replacement; removing it moves focus to the next row.
    await row(page, 0, pathAt(3)).click()
    await updateEntries(page, `return entries.map(entry => entry.path === "${pathAt(3)}" ? { ...entry, stagedAdditions: 9 } : entry)`)
    assert.equal(await row(page, 0, pathAt(3)).locator("small").textContent(), "+9 −1")
    assert.deepEqual(await active(page), { tag: "BUTTON", name: pathAt(3), section: 0 })
    await updateEntries(page, `return entries.filter(entry => entry.path !== "${pathAt(3)}")`)
    assert.equal(await row(page, 0, pathAt(3)).count(), 0)
    assert.deepEqual(await active(page), { tag: "BUTTON", name: pathAt(4), section: 0 })

    // One staged file and an unrelated unstaged row selected: the commit box offers "Stage · b.ts".
    await updateEntries(page, `return ["a", "b", "c"].map(name => ({ path: "packages/app/" + name + ".ts", originalPath: null,
      stagedStatus: name === "a" ? "modified" : null, stagedAdditions: 1, stagedDeletions: 0,
      unstagedStatus: name === "a" ? null : "modified", unstagedAdditions: 1, unstagedDeletions: 0 }))`)
    await row(page, 1, "packages/app/b.ts").click()
    await page.locator(".git-change-commit-box").getByRole("button", { name: "Indexer le fichier · packages/app/b.ts", exact: true }).waitFor()
    await section(page, 0).getByRole("button", { name: "Retirer de l'index · packages/app/a.ts", exact: true }).click()
    await row(page, 1, "packages/app/a.ts").waitFor()
    assert.equal(await row(page, 0, "packages/app/a.ts").count(), 0)
    assert.deepEqual(await active(page), { tag: "BUTTON", name: "header", section: 0 }, "never the commit box's action on another file")
    await page.keyboard.press("Enter")
    assert.deepEqual(await calls(page, "stage"), [], "the next Enter stages nothing")
  } finally { await page.close() }
})

test("sticky rows stay after the selection moves, leave with their file and clear on a worktree change", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openLargeInventory(page)
    await row(page, 1, pathAt(STAGED + 1)).click()
    assert.equal(await row(page, 1, pathAt(MOST_CHANGED)).getAttribute("aria-current"), null)
    assert.equal(await rows(page, 1).count(), BOUND + 1, "the formerly current row beyond the bound stays")
    const most = pathAt(MOST_CHANGED)
    await updateEntries(page, `globalThis.removedEntry = entries.find(entry => entry.path === "${most}"); return entries.filter(entry => entry !== globalThis.removedEntry)`)
    assert.equal(await row(page, 1, most).count(), 0)
    await updateEntries(page, `return [...entries, globalThis.removedEntry]`)
    assert.equal(await section(page, 1).locator(".git-change-section-count").textContent(), String(UNSTAGED))
    assert.equal(await row(page, 1, most).count(), 0, "a returning file is not pinned again")
    assert.equal(await rows(page, 1).count(), BOUND)

    // A row selected after a reveal stays sticky until the worktree changes.
    await showMore(page).click()
    const far = pathAt(STAGED + 300)
    await row(page, 1, far).click()
    await row(page, 1, pathAt(STAGED + 2)).click()
    const reads = await page.evaluate(() => (window as any).gitScale.calls)
    const selector = page.getByRole("combobox", { name: "Worktree à consulter" })
    await selector.selectOption("review")
    await page.waitForFunction(reads => (window as any).gitScale.calls > reads, reads)
    await selector.selectOption("root")
    await page.waitForFunction(reads => (window as any).gitScale.calls > reads + 1, reads)
    await row(page, 1, most).waitFor()
    assert.equal(await row(page, 1, far).count(), 0, "a worktree change clears sticky rows")
    assert.equal(await rows(page, 1).count(), BOUND + 1, "only the newly auto-selected row joins the bound")
  } finally { await page.close() }
})
