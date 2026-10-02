import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "server-info-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/server-info.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const baseMeta = {
  localUrl: "http://127.0.0.1:9899", remoteUrl: "https://192.0.2.1:9898", eventsUrl: "/api/events",
  host: "0.0.0.0", listeningMode: "all", localPort: 9899, hostLabel: "Debian fixture",
  workspaceRoot: "/fixture", addresses: [], serverVersion: "0.20.0", ui: { version: "0.20.0", source: "bundled" },
}

async function setup(page: Page, host: "web" | "tauri" | "electron") {
  await page.addInitScript({ content: `{
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: ${JSON.stringify(host)}, __CODENOMAD_WINDOW_CONTEXT__: "remote" })
    Object.defineProperty(navigator, "platform", { value: "Win32" })
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "Windows" } })
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedReport = text } } })
  }` })
}

function rowValue(page: Page, label: string) {
  return page.locator(".settings-info-row").filter({ has: page.getByText(label, { exact: true }) }).locator(".settings-info-value")
}

for (const host of ["web", "tauri", "electron"] as const) test(`${host}: Windows client displays remote Linux server metadata separately and exports it`, async () => {
  const page = await browser.newPage({ locale: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await setup(page, host)
  let system = { platform: "linux", arch: "arm64" }
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(new URL(route.request().url()).pathname === "/api/meta" ? { ...baseMeta, system } : {}) }))
  try {
    await page.goto(url)
    await rowValue(page, "Server operating system").waitFor()
    assert.equal(await rowValue(page, "Server operating system").innerText(), "Linux")
    assert.equal(await rowValue(page, "Server architecture").innerText(), "arm64")
    assert.equal(await rowValue(page, "Client operating system").innerText(), "Windows x64")
    assert.equal(await rowValue(page, "Client runtime").innerText(), host)
    await page.getByRole("button", { name: "Copy to clipboard", exact: true }).click()
    await page.waitForFunction(() => !!(window as any).copiedReport)
    const report = await page.evaluate(() => (window as any).copiedReport as string)
    assert.match(report, /Server operating system: Linux/)
    assert.match(report, /Server architecture: arm64/)
    assert.match(report, /Client operating system: Windows x64/)
    const downloadReady = page.waitForEvent("download")
    await page.getByRole("button", { name: "Download .txt", exact: true }).click()
    const download = await downloadReady
    const downloadedReport = await readFile((await download.path())!, "utf8")
    assert.match(downloadedReport, /Server operating system: Linux/)
    assert.match(downloadedReport, /Server architecture: arm64/)
    assert.match(downloadedReport, /Client operating system: Windows x64/)
    // Explicit metadata refresh updates the server rows, never the client rows.
    system = { platform: "darwin", arch: "x64" }
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll(".settings-info-value")].some(e => e.textContent === "macOS"))
    assert.equal(await rowValue(page, "Server architecture").innerText(), "x64")
    assert.equal(await rowValue(page, "Client operating system").innerText(), "Windows x64")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, content: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("older or unreachable servers never borrow the client platform", async () => {
  const page = await browser.newPage({ locale: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
  await setup(page, "web")
  let unavailable = false
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/meta"
    ? route.fulfill(unavailable ? { status: 503, body: "unavailable" } : { contentType: "application/json", body: JSON.stringify(baseMeta) })
    : route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await rowValue(page, "Server operating system").waitFor()
    assert.equal(await rowValue(page, "Server operating system").innerText(), "—")
    assert.equal(await rowValue(page, "Server architecture").innerText(), "—")
    unavailable = true
    await page.reload()
    await page.getByRole("alert").waitFor()
    await page.getByRole("button", { name: "Copy to clipboard", exact: true }).click()
    await page.waitForFunction(() => !!(window as any).copiedReport)
    const report = await page.evaluate(() => (window as any).copiedReport as string)
    assert.match(report, /Server operating system: —/)
    assert.match(report, /Server architecture: —/)
    assert.match(report, /Client operating system: Windows x64/)
  } finally { await page.close() }
})
