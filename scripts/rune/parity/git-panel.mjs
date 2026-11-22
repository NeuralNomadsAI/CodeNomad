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

function native(scene, theme, stem, script, mark = "end", width) {
  const tree = path.join(out, `${stem}.json`)
  const png = path.join(out, `${stem}.png`)
  const env = { ...process.env, RUNE_LOCALE: "fr", CODENOMAD_PROFILE: "trial-git-parity" }
  for (const key of Object.keys(env)) if (key.startsWith("RUNE_") && key !== "RUNE_LOCALE") delete env[key]
  if (width) env.RUNE_GIT_PANEL_WIDTH = String(width)
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
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport })
    page.on("pageerror", error => console.error(error))
    page.on("requestfailed", request => console.error(request.url(), request.failure()))
    await page.goto(url)
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    await page.locator(".git-diff-view .line-insert").first().waitFor()
    await page.evaluate(async theme => {
      const { setThemePreference } = await import("/src/stores/preferences.tsx")
      await setThemePreference(theme)
    }, theme)
    for (const mode of ["changes", "commits"]) {
      if (mode === "commits") {
        await page.getByRole("button", { name: "Commits", exact: true }).click()
        await page.getByText("Make Git history the starting point").waitFor()
      }
      const name = `${mode}-${theme}`
      await page.screenshot({ path: path.join(out, `solid-${name}.png`) })
      await writeFile(path.join(out, `solid-${name}.yaml`), await page.locator("body").ariaSnapshot())
      const tree = JSON.parse(await readFile(native(`git-${mode}`, theme, `rune-${name}`, settle), "utf8"))
      const nodes = elements(tree)
      assert.equal(tree.dark_system, theme === "dark")
      assert(nodes.some(node => node.name?.includes("src/components/git-panel.tsx")))
      assert(nodes.some(node => node.name?.includes(mode === "changes" ? "Changements" : "Make Git history")))
      assert(nodes.some(node => node.key === "git-diff-mode" && node.role === "button" && node.name))
      report.push({ theme, mode, nativeNodes: nodes.length })
    }
    await page.close()
  }
  const script = path.join(out, "interaction.json")
  await writeFile(script, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-row-staged:file:src/components/git-panel.tsx" },
    { t: 0.4, type: "tap", key: "git-diff-mode" },
    { t: 0.6, type: "mark", name: "selected" },
    { t: 0.8, type: "tap", key: "git-section-staged" },
    { t: 1.0, type: "mark", name: "end" },
  ] }))
  const selected = elements(JSON.parse(await readFile(native("git-changes", "dark", "selection", script, "selected"), "utf8")))
  assert(selected.some(node => node.key === "git-row-staged:file:src/components/git-panel.tsx" && node.states.includes("checked")))
  const tree = JSON.parse(await readFile(native("git-changes", "dark", "interaction", script), "utf8"))
  const nodes = elements(tree)
  assert(nodes.some(node => node.key === "git-section-staged" && !node.states.includes("expanded")))
  assert(nodes.some(node => node.key === "git-diff-mode" && node.states.includes("checked")))
  const compact = path.join(out, "compact-interaction.json")
  await writeFile(compact, JSON.stringify({ events: [
    { t: 0.2, type: "tap", key: "git-row-staged:menu:src/components/git-panel.tsx:trigger" },
    { t: 0.6, type: "mark", name: "end" },
  ] }))
  const menu = elements(JSON.parse(await readFile(native("git-changes", "dark", "compact", compact, "end", 180), "utf8")))
  assert(menu.some(node => node.role === "menu-item" && node.key?.endsWith(":item:stage") && node.states.includes("focused")))
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(`Git captures and accessibility trees: ${out}`)
} finally {
  await browser?.close()
  await vite?.close()
  await rm(scratch, { recursive: true, force: true })
}
