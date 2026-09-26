import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL("..", import.meta.url))
const output = path.resolve(root, "../../docs/screenshots/workspace-0.20.png")
const server = await createServer({ configFile: false, root, logLevel: "error",
  plugins: [solid(), { name: "readme-capture", configureServer(server) {
    server.middlewares.use("/api/events", (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write(": documentation fixture\n\n")
      req.on("close", () => res.end())
    })
    server.middlewares.use("/readme", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await server.transformIndexHtml("/readme", '<html lang="en"><head><title>CodeNomad — demo workspace</title></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/readme-workspace.tsx"></script></body></html>'))
    })
  } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
})
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", timezoneId: "UTC" })
  const errors = []
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message) })
  page.on("console", message => { if (message.type() === "error") console.error(message.text()) })
  // No user backend, shared daemon, provider, or external website is contacted.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === "/api/events") return route.continue()
    if (url.pathname.includes("/api/") || url.pathname.startsWith("/workspaces/")) {
      return route.fulfill({ contentType: "application/json", body: "{}" })
    }
    return route.continue()
  })
  await page.goto(`${origin}/readme`)
  await page.getByText("Keyboard navigation is ready", { exact: true }).waitFor()
  await page.getByText("Connected", { exact: true }).waitFor()
  await page.getByText("project-docs", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Agent: Build", exact: true }).waitFor()
  assert.equal(await page.locator("[data-app-tab-id]").count(), 8, "Show all eight demo projects")
  await page.getByText("Add workspace notifications", { exact: true }).waitFor()
  await page.waitForFunction(() => Number(document.querySelector(".message-timeline")?.getAttribute("data-segment-count")) >= 180)
  await page.locator('.message-timeline-segment[data-message-id="msg_01"]').waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1500)
  assert.equal(await page.locator(".keyboard-hints:visible, .kbd-hint:visible").count(), 0,
    "Keyboard shortcut hints must remain hidden with the default preference")
  assert.deepEqual(errors, [], "The documentation fixture must render without uncaught errors")
  await mkdir(path.dirname(output), { recursive: true })
  await page.screenshot({ path: output, animations: "disabled" })
  console.log(output)
} finally {
  await browser?.close()
  await server.close()
}
