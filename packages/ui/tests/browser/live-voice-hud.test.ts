import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, baseUrl: string

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [
      solid(),
      {
        name: "live-voice-hud-fixture",
        configureServer(server) {
          server.middlewares.use("/fixture", async (_req, res) => {
            res.setHeader("Content-Type", "text/html")
            res.end(
              await server.transformIndexHtml(
                "/fixture",
                `<html>
                  <head>
                    <link rel="stylesheet" href="/src/index.css" />
                  </head>
                  <body>
                    <div id="root"></div>
                    <script type="module" src="/tests/browser/fixtures/live-voice-hud.tsx"></script>
                  </body>
                </html>`
              )
            )
          })
        },
      },
    ],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })

  await server.listen()
  baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({
    executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    headless: true,
  })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test("Live Voice HUD: mounts with square styling, renders canvas visualizer, and supports keyboard dismiss", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  await page.goto(`${baseUrl}/fixture`)
  await page.waitForSelector("#open-voice-hud-btn")

  // Open HUD
  await page.click("#open-voice-hud-btn")
  await page.waitForSelector("#live-voice-hud-window")

  // Verify square corners (AGENT NOTES constraint)
  const hudElement = await page.$("#live-voice-hud-window")
  assert.ok(hudElement, "HUD should be mounted in the DOM")

  const borderRadius = await page.evaluate(() => {
    const el = document.getElementById("live-voice-hud-window")
    return el ? window.getComputedStyle(el).borderRadius : null
  })
  assert.equal(borderRadius, "0px", "HUD shell must strictly have 0px border-radius")

  // Verify Canvas visualizer exists and is rendered
  const canvas = await page.$("canvas.live-voice-hud-canvas")
  assert.ok(canvas, "Visualizer canvas must be present in the HUD")

  // Verify status badge
  const statusBadge = await page.$(".live-voice-hud-status-badge")
  assert.ok(statusBadge, "Status badge should be visible")

  // Verify Escape key dismissal
  await page.keyboard.press("Escape")
  await page.waitForSelector("#live-voice-hud-window", { state: "detached" })

  assert.equal(errors.length, 0, `Browser console errors: ${errors.join("; ")}`)
  await page.close()
})
