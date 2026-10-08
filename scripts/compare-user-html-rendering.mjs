// Compare actual historical/current UI rendering, without an OpenCode runtime or worktree.
// The tagged renderer uses the installed frontend dependency versions; this is not
// a packaged-app or dependency-lockfile comparison.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.join(repo, "packages/ui")
const tag = "v0.19.0"
const historical = ["components/message-part.tsx", "components/markdown.tsx", "lib/markdown.ts", "lib/text-render-utils.ts"]
const evidence = await mkdtemp(path.join(os.tmpdir(), "opencode", "issue776-compare-"))
const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
const results = []
try {
  for (const baseline of [true, false]) {
    const sources = new Map(baseline ? historical.map(file => [path.join(root, "src", file).replaceAll("\\", "/"),
      execFileSync("git", ["show", `${tag}:packages/ui/src/${file}`], { cwd: repo, encoding: "utf8" })]) : [])
    const server = await createServer({ configFile: false, root, logLevel: "error", plugins: [
      { name: "historical-renderer", enforce: "pre", load(id) { return sources.get(id.replaceAll("\\", "/")) },
        configureServer(server) { server.middlewares.use("/compare", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/compare", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/user-html.tsx"></script></body></html>'))
        }) } }, solid()], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await server.listen()
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/compare`)
      await page.locator("#user strong").waitFor()
      await page.locator("#assistant .sample-html").waitFor()
      await page.locator("#pasted summary").click()
      await page.locator("#pasted .markdown-body").waitFor()
      const result = await page.evaluate(() => ({
        userElements: document.querySelectorAll("#user .sample-html").length,
        pastedElements: document.querySelectorAll("#pasted .sample-html").length,
        assistantHtml: document.querySelector("#assistant .sample-html").outerHTML,
        literalUserTag: document.querySelector("#user").textContent.includes('<div class="sample-html">'),
        literalPastedTag: document.querySelector("#pasted").textContent.includes('<div class="sample-html">'),
      }))
      assert.deepEqual(errors, [])
      results.push({ version: baseline ? tag : "working-tree", ...result })
      await page.screenshot({ path: path.join(evidence, baseline ? "v0.19.0.png" : "fixed.png"), fullPage: true })
    } finally { await page.close(); await server.close() }
  }
  assert.equal(results[0].userElements, 1, "v0.19.0 also interpreted allowed user HTML")
  assert.equal(results[0].pastedElements, 1)
  assert.equal(results[1].userElements, 0)
  assert.equal(results[1].pastedElements, 0)
  assert.equal(results[1].literalUserTag, true)
  assert.equal(results[1].literalPastedTag, true)
  assert.equal(results[0].assistantHtml, results[1].assistantHtml, "Assistant HTML output must remain identical")
  console.log(JSON.stringify({ evidence, results }, null, 2))
} finally {
  await browser.close()
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2))
}
