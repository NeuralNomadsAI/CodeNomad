// Capture the real Solid fixture and the matching native scene, without visible windows.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "../../../packages/ui/tests/browser/fixtures/git-history-assets.mjs"
import { requireTestSupport } from "../../../packages/rune-app/fixtures/fixture-binaries.mjs"

const [binary, out] = process.argv.slice(2)
assert(binary && out && path.isAbsolute(binary) && path.isAbsolute(out))
requireTestSupport(binary)
await mkdir(out, { recursive: true })
const scratch = await mkdtemp(path.join(out, "solid-cache-"))
const root = fileURLToPath(new URL("../../../", import.meta.url))
const ui = path.join(root, "packages/ui")
const viewport = { width: 1030, height: 700 }
const report = []
let vite, browser

function elements(tree) {
  const nodes = []
  const walk = node => {
    if (node == null) return
    nodes.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree.accessibility)
  return nodes
}

function native(scene, theme, stem, script, mark = "end", width, locale = "fr", detail) {
  const tree = path.join(out, `${stem}.json`)
  const png = path.join(out, `${stem}.png`)
  const env = { ...process.env, RUNE_LOCALE: locale, CODENOMAD_PROFILE: "trial-git-parity" }
  for (const key of Object.keys(env)) if (key.startsWith("RUNE_") && key !== "RUNE_LOCALE") delete env[key]
  if (width) env.RUNE_GIT_PANEL_WIDTH = String(width)
  if (detail === "commit" || detail === "hash") env.RUNE_GIT_COMMIT_DETAIL = detail
  else if (detail === "subject") env.RUNE_GIT_LONG_SUBJECT = "1"
  else if (detail) env.RUNE_GIT_PANEL_STATE = detail
  const args = ["--scene", scene, "--theme", theme, "--tree", tree, "--snap", png,
    "--size", `${viewport.width}x${viewport.height}`, "--scale", "1"]
  if (script) args.push("--script", script, "--at", `mark:${mark}`)
  const result = spawnSync(binary, args, { cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 120_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return tree
}

try {
  prepareGitPrototypeAssets()
  vite = await createServer({
    configFile: false, root: ui, cacheDir: scratch, publicDir: path.join(ui, "src/renderer/public"),
    plugins: [solid(), { name: "git-panel-parity", configureServer(server) {
      server.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end(await server.transformIndexHtml("/fixture", '<html><head><title>CodeNomad</title></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/git-history.tsx"></script></body></html>'))
      })
    }}],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/fixture`
  browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH })
  const settle = path.join(out, "settle.json")
  await writeFile(settle, JSON.stringify({ events: [{ t: 0.6, type: "mark", name: "end" }] }))
  for (const [theme, locale] of [["light", "fr"], ["dark", "fr"], ["dark", "tr"]]) {
    const page = await browser.newPage({ viewport })
    page.on("pageerror", error => console.error(error))
    page.on("requestfailed", request => console.error(request.url(), request.failure()))
    await page.goto(url)
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    await page.locator(".git-diff-view .line-insert").first().waitFor()
    await page.evaluate(async ({ theme, locale }) => {
      const { setThemePreference, updatePreferences } = await import("/src/stores/preferences.tsx")
      await setThemePreference(theme)
      await updatePreferences({ locale })
    }, { theme, locale })
    await page.waitForFunction(({ theme, locale }) =>
      document.documentElement.dataset.theme === theme && document.documentElement.lang === locale, { theme, locale })
    await page.evaluate(() => {
      // Rune consumes the base CSS tokens, not the fixture's user palette overrides.
      const { style } = document.documentElement
      for (const name of [...style]) if (name.startsWith("--")) style.removeProperty(name)
    })
    const solidModes = page.locator(".git-panel-switch button")
    for (const mode of locale === "fr" ? ["changes", "commits"] : ["changes"]) {
      if (mode === "commits") {
        await solidModes.nth(2).click()
        await page.getByText("Make Git history the starting point").waitFor()
      }
      await page.evaluate(() => document.fonts.ready)
      const name = `${mode}-${theme}${locale === "fr" ? "" : `-${locale}`}`
      await page.screenshot({ path: path.join(out, `solid-${name}.png`) })
      await writeFile(path.join(out, `solid-${name}.yaml`), await page.locator("body").ariaSnapshot())
      const tree = JSON.parse(await readFile(native(`git-${mode}`, theme, `rune-${name}`, settle, "end", undefined, locale), "utf8"))
      const nodes = elements(tree)
      assert.equal(tree.dark_system, theme === "dark")
      const worktree = tree.elements.find(node => node.key === "git-worktree-trigger")
      const directory = await page.locator(".git-panel-worktree").getAttribute("title")
      assert(directory)
      assert.equal(worktree?.help, directory)
      assert.equal(nodes.find(node => node.key === "git-worktree-trigger")?.description, directory)
      assert(nodes.some(node => node.name?.includes("src/components/git-panel.tsx")))
      assert(nodes.some(node => node.key === "git-diff-mode" && node.role === "button" && node.name))
      const firstCommit = nodes.find(node => node.role === "button" && node.name?.startsWith("Make Git history"))
      if (mode === "commits") {
        assert(firstCommit?.key)
        const author = await page.locator(".git-history-meta > span").first().textContent()
        assert(author && firstCommit.name.includes(author), `${name}: use the same localized month and day as Solid`)
      }
      else {
        assert(nodes.some(node => node.key === "git-section-staged" && node.states.includes("expanded")))
        const bulk = tree.elements.find(node => node.key === "git-bulk-unstaged")
        const source = page.locator(".git-change-commit-box button[title]").first()
        const paths = await source.getAttribute("title")
        assert(paths)
        assert.equal(bulk?.help, paths)
        assert.equal(nodes.find(node => node.key === "git-bulk-unstaged")?.description, paths)
      }
      const solidPanel = await page.locator(".git-panel").boundingBox()
      const runePanel = tree.elements.find(node => node.key === "git-panel")?.rect
      assert(solidPanel && runePanel)
      const geometry = {}
      for (const [label, query, key] of [
        ["context", ".git-panel-context", "git-context"],
        ["worktree", ".git-panel-worktree", "git-worktree-trigger"],
        ["tools", ".git-panel-tools", "git-tools"],
        ["modes", ".git-panel-switch", "git-mode"],
        mode === "changes"
          ? ["stagedHeader", ".git-change-section-header", "git-section-staged"]
          : ["firstCommit", ".git-history-row", firstCommit.key],
      ]) {
        const solid = await page.locator(query).first().boundingBox()
        const rune = tree.elements.find(node => node.key === key)?.rect
        assert(solid && rune, `${mode}/${theme}: missing ${label} geometry`)
        geometry[label] = {
          solid: [solid.x - solidPanel.x, solid.y - solidPanel.y, solid.width, solid.height],
          rune: [rune[0] - runePanel[0], rune[1] - runePanel[1], rune[2], rune[3]],
        }
      }
      const row = geometry[mode === "changes" ? "stagedHeader" : "firstCommit"]
      assert(Math.abs(row.solid[3] - row.rune[3]) <= 2, `${mode}/${theme}: row height differs by more than 2 px`)
      assert(Math.abs(geometry.worktree.solid[2] - geometry.worktree.rune[2]) <= 2, `${name}: worktree control must span the panel`)
      assert(Math.abs(geometry.worktree.solid[3] - geometry.worktree.rune[3]) <= 2, `${name}: worktree control height differs by more than 2 px`)
      const [solidWidth, runeWidth] = [geometry.modes.solid[2], geometry.modes.rune[2]]
      // Allow font raster/measurement differences, not a full-width or equal-column selector.
      assert(Math.abs(solidWidth - runeWidth) <= 8, `${name}: selector width ${runeWidth} vs ${solidWidth} px`)
      const segments = await solidModes.evaluateAll(buttons => buttons.map(button => ({
        label: button.textContent.trim(), width: button.getBoundingClientRect().width,
      })))
      assert.equal(segments.length, 3)
      for (const [i, segment] of segments.entries()) {
        const rune = tree.elements.find(node => node.key === `segment${i}` && node.role === "radio")
        assert.equal(rune?.label, segment.label)
        assert(Math.abs(segment.width - rune.rect[2]) <= 4, `${name}: ${segment.label} segment width ${rune.rect[2]} vs ${segment.width} px`)
      }
      if (locale === "tr") {
        const title = tree.elements.find(node => node.key === "git-section-title" && node.path.includes("/git-section-unstaged/"))
        assert.equal(title?.text, "Değişiklikler")
      }
      report.push({ theme, locale, mode, nativeNodes: nodes.length, geometry })
    }
    if (locale === "fr") {
      await page.locator(".git-history-row").first().click()
      const back = page.locator(".git-panel-back")
      const summary = page.locator(".git-commit-summary")
      await summary.getByText("2 fichiers modifiés", { exact: true }).waitFor()
      await page.screenshot({ path: path.join(out, `solid-commit-detail-${theme}.png`) })
      const detail = JSON.parse(await readFile(native("git-commits", theme, `rune-commit-detail-${theme}`, settle, "end", undefined, locale, "commit"), "utf8"))
      for (const [solid, key] of [[back, "git-history-back"], [summary, "git-commit-summary"]]) {
        const a = await solid.boundingBox()
        const b = detail.elements.find(node => node.key === key)?.rect
        assert(a && b && Math.abs(a.width - b[2]) <= 2, `${theme}: ${key} spans the panel`)
      }
      assert(detail.elements.some(node => node.text === "2 fichiers modifiés" && node.path.includes("/git-commit-summary/")))
      assert(elements(detail).some(node => node.key === "git-commit-file-preview-src/components/git-panel.tsx" && node.role === "button"))
      await back.click()
      await page.locator(".git-history-row").first().waitFor()
    }
    await page.close()
  }
  const back = path.join(out, "commit-back-script.json")
  await writeFile(back, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-history-back" },
    { t: 0.6, type: "mark", name: "end" },
  ] }))
  const history = JSON.parse(await readFile(native("git-commits", "dark", "commit-back", back, "end", undefined, "fr", "commit"), "utf8"))
  assert(elements(history).some(node => node.role === "button" && node.name?.startsWith("Make Git history")))
  const focus = path.join(out, "commit-focus-script.json")
  await writeFile(focus, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-commit-file-src/components/git-panel.tsx" },
    { t: 0.4, type: "key", name: "Tab", shift: true },
    { t: 0.6, type: "mark", name: "end" },
  ] }))
  const compactDetail = async (stem, script) =>
    JSON.parse(await readFile(native("git-commits", "dark", stem, script, "end", 180, "fr", "hash"), "utf8"))
  const unfocused = await compactDetail("commit-detail-180", settle)
  const keyboard = await compactDetail("commit-focus-180", focus)
  const backButton = tree => tree.elements.find(node => node.key === "git-history-back")
  assert(keyboard.elements.some(node => node.key === "git-history-back" && node.focusVisible))
  assert.equal(backButton(keyboard).fill, backButton(unfocused).fill, "Focus must not tint the return row")
  const summary = unfocused.elements.find(node => node.key === "git-commit-summary")
  const sha = unfocused.elements.find(node => node.path.includes("/git-commit-summary/") && /^[0-9a-f]{64}$/.test(node.text))
  const short = unfocused.elements.find(node => node.path.includes("/git-commit-summary/") && node.text === "11111111")
  assert(summary && sha && short && sha.rect[3] > 2 * short.rect[3], "A SHA-256 must wrap over multiple lines at 180 px")
  assert(sha.rect[0] + sha.rect[2] <= summary.rect[0] + summary.rect[2], "The SHA-256 must stay inside the summary")
  const script = path.join(out, "interaction-script.json")
  await writeFile(script, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-row-staged:file:src/components/git-panel.tsx" },
    { t: 0.4, type: "tap", key: "git-diff-mode" },
    { t: 0.6, type: "mark", name: "selected" },
    { t: 0.8, type: "tap", key: "git-section-staged" },
    { t: 1.0, type: "mark", name: "collapsed" },
    { t: 1.2, type: "tap", key: "segment2" },
    { t: 1.4, type: "mark", name: "end" },
  ] }))
  const selected = elements(JSON.parse(await readFile(native("git-changes", "dark", "selection", script, "selected"), "utf8")))
  assert(selected.some(node => node.key === "git-row-staged:file:src/components/git-panel.tsx" && node.states.includes("checked")))
  const tree = JSON.parse(await readFile(native("git-changes", "dark", "interaction", script, "collapsed"), "utf8"))
  const nodes = elements(tree)
  assert(nodes.some(node => node.key === "git-section-staged" && !node.states.includes("expanded")))
  assert(nodes.some(node => node.key === "git-diff-mode" && node.states.includes("checked")))
  for (const width of [360, 180]) {
    const switched = JSON.parse(await readFile(native("git-changes", "dark", `mode-switch-${width}`, script, "end", width), "utf8"))
    assert(elements(switched).some(node => node.role === "button" && node.name?.startsWith("Make Git history")), `Commits must open at ${width} px`)
    assert(switched.elements.some(node => node.key === "segment2" && node.itemSelected), `Commits must be selected at ${width} px`)
  }
  const compact = path.join(out, "compact-interaction.json")
  await writeFile(compact, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-row-staged:menu:src/components/git-panel.tsx:trigger" },
    { t: 0.6, type: "mark", name: "end" },
  ] }))
  const narrow = JSON.parse(await readFile(native("git-changes", "dark", "compact", compact, "end", 180), "utf8"))
  const menu = elements(narrow)
  assert(menu.some(node => node.role === "menu-item" && node.key?.endsWith(":item:stage") && node.states.includes("focused")))
  const narrowModes = narrow.elements.find(node => node.key === "git-mode")?.rect
  assert(narrowModes && narrowModes[2] < 180, "The mode selector must fit a compact panel")
  const long = JSON.parse(await readFile(native("git-commits", "dark", "long-subject-180", settle, "end", 180, "fr", "subject"), "utf8"))
  const panel = long.elements.find(node => node.key === "git-panel")
  const firstRow = `/git-commit-${"1".repeat(40)}/`
  const subject = long.elements.find(node => node.path.includes(firstRow) && /^[0-9a-f]{64}$/.test(node.text))
  const shortId = long.elements.find(node => node.path.includes(firstRow) && node.text === "1111111")
  assert(panel && subject && shortId && subject.rect[3] > 2 * shortId.rect[3], "Long commit subjects must wrap at 180 px")
  assert(subject.rect[0] + subject.rect[2] <= panel.rect[0] + panel.rect[2], "The subject must stay inside the panel")
  const catalogue = JSON.parse(await readFile(path.join(root, "crates/rune-theme-codenomad/assets/catalogues/fr.json"), "utf8"))
  for (const [mode, emptyKey, failure] of [
    ["changes", "instanceShell.gitChanges.empty", "fixture status refused"],
    ["commits", "gitPanel.emptyHistory", "fixture history refused"],
  ]) {
    const view = async state => {
      const filename = native(`git-${mode}`, "dark", `${mode}-${state}`, settle, "end", undefined, "fr", state)
      return elements(JSON.parse(await readFile(filename, "utf8")))
    }
    const empty = catalogue[emptyKey]
    assert(empty)
    assert((await view("empty")).some(node => node.role === "status" && node.name === empty))
    const failed = await view("error")
    assert(failed.some(node => node.role === "alert" && node.name?.includes(failure)))
    assert(!failed.some(node => node.name === empty), "Read failure must not claim the checkout is empty")
  }
  for (const [state, diagnostic] of [
    ["uninitialized", catalogue["filesPanel.gitInit.notRepository"]],
    ["no-git", "Git is missing from the backend PATH. Restart CodeNomad after changing PATH."],
  ]) {
    const filename = native("git-changes", "dark", state, settle, "end", undefined, "fr", state)
    const tree = JSON.parse(await readFile(filename, "utf8"))
    assert(tree.elements.some(node => node.path.includes("/git-branch/") && node.text === "CodeNomad"))
    assert(elements(tree).some(node => node.name === diagnostic))
    assert.equal(elements(tree).some(node => node.key === "git-init"), state === "uninitialized")
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(`Git captures and accessibility trees: ${out}`)
} finally {
  await browser?.close()
  await vite?.close()
  await rm(scratch, { recursive: true, force: true })
}
