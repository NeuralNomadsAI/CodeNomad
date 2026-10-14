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

const issueTemplate = readFile(fileURLToPath(new URL("../../../../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url)), "utf8")

async function setup(page: Page, host: "web" | "tauri" | "electron", template?: { status: number; body: string }) {
  // The published issue form is a fixture too; tests never reach GitHub.
  await page.route("https://raw.githubusercontent.com/**", async route => route.fulfill(template ?? { status: 200, body: await issueTemplate }))
  await page.addInitScript({ content: `{
    window.open = (url) => { (window.openedUrls ??= []).push(url); return null }
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

test("the update feed is saved as a server preference and only changes the offered release", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  await setup(page, "tauri")
  const patches: unknown[] = []
  let feed = "preview"
  const preview = { version: "0.20.1-dev-20261009-43165435", tag: "v0.20.1-dev-20261009-43165435", url: "https://example.test/preview", channel: "preview" }
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.method() === "PATCH") {
      const body = request.postDataJSON()
      patches.push({ path: new URL(request.url()).pathname, body })
      if (body?.updateFeed) feed = body.updateFeed
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body ?? {}) })
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(new URL(request.url()).pathname === "/api/meta"
      ? { ...baseMeta, serverVersion: "0.20.1-dev-20261008-027f5094", updateFeed: feed, update: feed === "preview" ? preview : null,
        support: { supported: true, latestServerVersion: "0.20.1", latestServerUrl: "https://example.test/stable" } }
      : {}) })
  })
  try {
    await page.goto(url)
    const selector = page.getByLabel("Update feed", { exact: true })
    await page.waitForFunction(() => (document.getElementById("settings-update-feed") as HTMLSelectElement | null)?.value === "preview")
    assert.equal(await rowValue(page, "Latest version").innerText(), preview.version)
    await selector.selectOption("stable")
    await page.waitForFunction(() => [...document.querySelectorAll(".settings-info-value")].some(e => e.textContent === "0.20.1"))
    assert.equal(await selector.inputValue(), "stable")
    assert.deepEqual(patches, [{ path: "/api/storage/config/server", body: { updateFeed: "stable" } }])
  } catch (error) {
    console.error({ patches, content: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("the preview feed never offers an older stable release through the SemVer fallback", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  await setup(page, "tauri")
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(new URL(route.request().url()).pathname === "/api/meta"
      ? { ...baseMeta, serverVersion: "0.20.1-dev-20261009-43165435", updateFeed: "preview", update: null,
        support: { supported: true, latestServerVersion: "0.20.1", latestServerUrl: "https://example.test/stable" } }
      : {}) }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => (document.getElementById("settings-update-feed") as HTMLSelectElement | null)?.value === "preview")
    assert.equal(await rowValue(page, "Latest version").innerText(), "—")
    assert.equal(await page.locator('a[href="https://example.test/stable"]').count(), 0)
  } finally { await page.close() }
})

test("the data profile row appears only for an explicit non-default profile", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  await setup(page, "electron")
  let desktopProfile: string | undefined
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(new URL(route.request().url()).pathname === "/api/meta" ? { ...baseMeta, desktopProfile } : {}) }))
  try {
    await page.goto(url)
    await rowValue(page, "Server operating system").waitFor()
    assert.equal(await page.getByTestId("settings-data-profile").count(), 0)
    desktopProfile = "dev-v2"
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.getByTestId("settings-data-profile").waitFor()
    assert.equal(await rowValue(page, "Data profile").innerText(), "dev-v2")
  } finally { await page.close() }
})

for (const published of ["current", "renamed"] as const) test(`Report a bug opens the ${published === "current" ? "prefilled issue form" : "blank issue fallback"}`, async () => {
  const page = await browser.newPage({ locale: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
  const body = (await issueTemplate).replace("id: os-version", "id: operating-system")
  await setup(page, "web", published === "renamed" ? { status: 200, body } : undefined)
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(path === "/api/meta"
      ? { ...baseMeta, system: { platform: "linux", arch: "arm64" } }
      : path === "/api/opencode/update" ? { state: "ready", currentVersion: "2.0.29", daemonVersion: "2.0.29" } : {}) })
  })
  const templateRead = page.waitForResponse(response => response.url().startsWith("https://raw.githubusercontent.com/"))
  try {
    await page.goto(url)
    await rowValue(page, "Server operating system").waitFor()
    // The section's warm read settles before the click, which never waits for it.
    await templateRead
    await page.getByRole("button", { name: "Report a bug", exact: true }).click()
    await page.waitForFunction(() => (window as any).openedUrls?.length === 1)
    const opened = new URL(await page.evaluate(() => (window as any).openedUrls[0] as string))
    assert.equal(opened.origin + opened.pathname, "https://github.com/NeuralNomadsAI/CodeNomad/issues/new")
    const environment = published === "current" ? opened.searchParams.get("extra")! : opened.searchParams.get("body")!
    if (published === "current") {
      assert.equal(opened.searchParams.get("template"), "bug_report.yml")
      assert.equal(opened.searchParams.get("codenomad-version"), "0.20.0")
      assert.equal(opened.searchParams.get("opencode-version"), "2.0.29")
      assert.equal(opened.searchParams.get("os-version"), "Windows x64")
    } else {
      assert.equal(opened.searchParams.has("template"), false)
      assert.match(environment, /CodeNomad Version: 0\.20\.0/)
      assert.match(environment, /OpenCode Version: 2\.0\.29/)
    }
    assert.match(environment, /Client: Web browser/)
    assert.match(environment, /Server OS: Linux arm64/)
    assert.match(environment, /Browser: Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/)
    assert.doesNotMatch(opened.href, /192\.0\.2\.1|127\.0\.0\.1|fixture/)
  } finally { await page.close() }
})

test("Report a bug opens the form at once while the published form cannot be read", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  await setup(page, "web")
  // Later routes take precedence: hold every template read without answering.
  const held: Array<() => Promise<void>> = []
  await page.route("https://raw.githubusercontent.com/**", route => { held.push(() => route.abort()) })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(new URL(route.request().url()).pathname === "/api/meta" ? baseMeta : {}) }))
  try {
    await page.goto(url)
    await rowValue(page, "Server operating system").waitFor()
    await page.waitForFunction(() => document.readyState === "complete")
    const button = page.getByRole("button", { name: "Report a bug", exact: true })
    for (const clicks of [1, 2]) {
      await button.click()
      await page.waitForFunction(count => (window as any).openedUrls?.length === count, clicks, { timeout: 500 })
    }
    const opened = await page.evaluate(() => (window as any).openedUrls.map((href: string) => new URL(href).searchParams.get("template")))
    assert.deepEqual(opened, ["bug_report.yml", "bug_report.yml"])
    assert.equal(held.length, 1, "the pending read is shared, not restarted per click")
  } finally { for (const abort of held) await abort().catch(() => {}); await page.close() }
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
