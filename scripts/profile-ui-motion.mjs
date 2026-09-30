// Bounded Chromium rendering traces, not a Task Manager/WebView2 GPU benchmark.
// Usage: node scripts/profile-ui-motion.mjs [baseline-git-ref]
// Only the baseline MCP component is substituted; all other sources/dependencies
// and the real StatusTab/SessionView fixture paths remain identical.
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
const baselineRef = process.argv[2]
const evidence = await mkdtemp(path.join(os.tmpdir(), "opencode", "issue804-motion-"))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
const results = []

async function sample(page, name, drive) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  await delay(300) // let one-off disclosure/scroll/transition work settle
  const animationSnapshot = await page.evaluate(() => document.getAnimations().filter(a =>
    a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity,
  ).map(a => ({ name: a.animationName, target: a.effect?.target?.getAttribute("class") })))
  const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]))
  const events = []
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value))
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,cc", transferMode: "ReportEvents" })
  const started = performance.now()
  if (drive) await drive()
  else await delay(1200)
  const elapsedMs = performance.now() - started
  const done = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve))
  await cdp.send("Tracing.end")
  await done
  const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]))
  const counts = {}
  for (const event of events) if (["Paint", "Layout", "UpdateLayoutTree", "DrawFrame"].includes(event.name)) {
    counts[event.name] = (counts[event.name] ?? 0) + 1
  }
  const result = { name, elapsedMs, animations: animationSnapshot, events: counts,
    metrics: Object.fromEntries(["LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"].map(key => [key, after[key] - before[key]])),
    mountedRows: await page.locator("[data-virtual-follow-key]").count(),
  }
  await writeFile(path.join(evidence, `${name}.json`), JSON.stringify({ traceEvents: events }))
  await page.screenshot({ path: path.join(evidence, `${name}.png`) })
  await cdp.detach()
  results.push(result)
}

try {
  for (const baseline of baselineRef ? [true, false] : [false]) {
    const component = "packages/ui/src/components/instance-service-status.tsx"
    const oldSource = baseline ? execFileSync("git", ["show", `${baselineRef}:${component}`], { cwd: repo, encoding: "utf8" }) : undefined
    const server = await createServer({ configFile: false, root, logLevel: "error", plugins: [
      { name: "motion-fixture", enforce: "pre", load(id) {
        if (id.replaceAll("\\", "/") === path.join(repo, component).replaceAll("\\", "/")) return oldSource
      }, configureServer(server) { server.middlewares.use("/motion", async (req, res) => {
        const fixture = req.url?.includes("streaming") ? "streaming-motion" : "mcp-motion"
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/motion", `<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/${fixture}.tsx"></script></body></html>`))
      }) } }, solid()], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    try {
      await server.listen()
      const url = `http://127.0.0.1:${server.httpServer.address().port}/motion`
      for (const reducedMotion of ["no-preference", "reduce"]) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1.5, reducedMotion, locale: "en-US" })
        const errors = []
        page.on("pageerror", error => errors.push(error.message))
        page.setDefaultTimeout(30_000)
        await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" }))
        const label = `${baseline ? "baseline" : "fixed"}-${reducedMotion}`
        try {
          await page.goto(url, { waitUntil: "domcontentloaded" })
          await page.waitForFunction(() => Boolean(window.mcpFixture))
          await sample(page, `${label}-mcp-expanded`)
          await page.locator(".right-panel-accordion-trigger").click()
          await page.locator(".status-dot").first().waitFor({ state: "hidden" })
          await sample(page, `${label}-mcp-collapsed`)
          if (!baseline) {
            await page.goto(`${url}?streaming`, { waitUntil: "domcontentloaded" })
            await page.waitForFunction(() => Boolean(window.motionFixture))
            await page.evaluate(() => window.motionFixture.seed())
            await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("History 619"))
            await sample(page, `${label}-session-idle`)
            await page.evaluate(() => window.motionFixture.start())
            await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Initial reasoning"))
            await sample(page, `${label}-thinking-no-deltas`)
            await page.evaluate(() => window.motionFixture.groupThinking())
            await page.locator(".message-technical-group-spinner").waitFor()
            await sample(page, `${label}-grouped-thinking-no-deltas`)
            await page.evaluate(() => window.motionFixture.text())
            let text = ""
            await sample(page, `${label}-streaming-paced-50ms`, async () => {
              for (let i = 0; i < 24; i++) {
                const delta = `Token ${i}. `
                text += delta
                await page.evaluate(delta => window.motionFixture.delta(delta), delta)
                await delay(50)
              }
            })
            await page.evaluate(text => window.motionFixture.finish(text), text)
            await sample(page, `${label}-session-complete`)
          }
          assert.deepEqual(errors, [])
        } finally { await page.close() }
      }
    } finally { await server.close() }
  }
  for (const result of results) {
    if (result.name.includes("-reduce-") || result.name.startsWith("fixed-") && result.name.includes("-mcp-")) {
      assert.equal(result.animations.length, 0, `${result.name} must not have perpetual animations`)
    }
    if (result.name.includes("-session-") || result.name.includes("-thinking-") || result.name.includes("-streaming-")) {
      assert.ok(result.mountedRows < 60, `${result.name} must retain bounded transcript mounting`)
    }
  }
  console.log(JSON.stringify({ evidence, results }, null, 2))
} finally {
  await browser.close()
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2))
}
