// Synthetic real-renderer workload; not a reproduction of the reporter's host.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")))
const chunkSize = Number(args.chunk ?? 1024), deliveriesCount = Number(args.deliveries ?? 96)
const temporaryParent = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryParent, { recursive: true })
const evidence = await mkdtemp(path.join(temporaryParent, "issue851-profile-"))
const server = await createServer({
  configFile: false, root: path.join(repo, "packages/ui"), logLevel: "error",
  cacheDir: "node_modules/.vite-streaming-profile", plugins: [solid(), {
    name: "streaming-profile", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;height:850px;width:1200px"></div><script type="module" src="/tests/browser/fixtures/streaming-motion.tsx"></script></body></html>'))
      })
    },
  }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
})
let browser
const results = []
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/fixture`
  for (const kind of args.kind ? [args.kind] : ["prose", "code", "burst"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    page.setDefaultTimeout(60000)
    await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" }))
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => Boolean(window.motionFixture))
    await page.evaluate(async () => { await window.motionFixture.seed(); window.motionFixture.start(); window.motionFixture.text() })
    await page.waitForTimeout(300)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
    const measurements = await page.evaluate(async ({ kind, chunkSize, deliveriesCount }) => {
      const tasks = [], gaps = [], deliveries = []
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration) })
      observer.observe({ type: "longtask", buffered: false })
      let previous = performance.now()
      const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now }, 10)
      let text = kind === "prose" ? "" : "```typescript\n"
      const line = kind === "prose" ? "A streamed paragraph with **important details** and a [reference](https://example.com).\n\n" : 'export const example = { name: "sample", enabled: true, count: 123 };\n'
      const chunk = line.repeat(Math.ceil(chunkSize / line.length))
      const started = performance.now()
      for (let i = 0; i < deliveriesCount; i++) {
        const delta = (i === 0 ? text : "") + chunk
        text += chunk
        const before = performance.now()
        window.motionFixture.delta(delta)
        deliveries.push(performance.now() - before)
        if (kind !== "burst") await new Promise(resolve => setTimeout(resolve, 20))
        else if (i % 16 === 15) await new Promise(resolve => setTimeout(resolve, 0))
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      const streamingMs = performance.now() - started
      window.motionFixture.finish(text)
      await new Promise(resolve => setTimeout(resolve, 250))
      clearInterval(timer)
      observer.disconnect()
      return { characters: text.length, streamingMs, longestDeliveryMs: Math.max(...deliveries), longTasks: tasks.length,
        totalLongTaskMs: tasks.reduce((sum, value) => sum + value, 0), longestTaskMs: Math.max(0, ...tasks),
        longestHeartbeatGapMs: Math.max(0, ...gaps),
        mountedRows: document.querySelectorAll("[data-virtual-follow-key]").length }
    }, { kind, chunkSize, deliveriesCount })
    const { profile } = await cdp.send("Profiler.stop")
    const counts = new Map()
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    const top = profile.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url.replace(url, "fixture"),
      line: node.callFrame.lineNumber + 1, samples: counts.get(node.id) ?? 0 })).sort((a, b) => b.samples - a.samples).slice(0, 20)
    await writeFile(path.join(evidence, `${kind}.cpuprofile`), JSON.stringify(profile))
    await page.screenshot({ path: path.join(evidence, `${kind}.png`) })
    results.push({ kind, ...measurements, errors, top })
    await page.close()
  }
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ evidence, results }, null, 2))
} finally { await browser?.close(); await server.close() }
