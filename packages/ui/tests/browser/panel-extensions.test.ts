import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, test } from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import Fastify from "fastify"
import { PanelExtensionStore } from "../../../server/src/panel-extensions/store"
import { readPanelExtensionArchive } from "../../../server/src/panel-extensions/archive"
import { fixtureArchive, fixtureManifest } from "../../../server/src/panel-extensions/archive-fixture"
import { registerPanelExtensionRoutes } from "../../../server/src/server/routes/panel-extensions"
import { createPanelExtensionCatalog, PANEL_EXTENSION_CATALOG_URL } from "../../../server/src/panel-extensions/catalog"
import { registerPanelExtensionAssetRoutes } from "../../../server/src/server/routes/panel-extension-assets"

const app = Fastify()
let server: ViteDevServer, browser: Browser, url: string, root: string, store: PanelExtensionStore
const example = `<style>body { font: 14px system-ui; color: #222; background: #fff; }</style><p id="context"></p><script>
  codenomad.onContext(context => document.querySelector('#context').textContent = context.sessionId + ' · ' + context.locale + ' · ' + context.appearance);
</script>`
const onlineArchive = fixtureArchive(example)
const onlineDigest = createHash("sha256").update(onlineArchive).digest("hex")
const onlineEntry = { manifest: fixtureManifest, description: "A catalogue example", digest: onlineDigest, release: { tag: "v1.0.0", asset: "example.session-1.0.0.zip" } }
let catalogEntries = [onlineEntry], catalogOffline = false, archiveRequests = 0
let assetUri = "", holdAssets: (() => Promise<void>) | undefined, assetReads = 0
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencode-panel-browser-"))
  store = new PanelExtensionStore(root)
  const catalog = createPanelExtensionCatalog((async (url: string | URL | Request) => {
    if (String(url) === PANEL_EXTENSION_CATALOG_URL) {
      if (catalogOffline) return new Response("Offline", { status: 503 })
      return new Response(JSON.stringify({ schemaVersion: 1, extensions: catalogEntries }))
    }
    archiveRequests++
    return new Response(new Uint8Array(onlineArchive).buffer)
  }) as typeof fetch)
  registerPanelExtensionRoutes(app, { store, catalog, workspaceManager: { get: id => ["first", "second"].includes(id) ? { id, path: `/${id}` } as any : undefined } })
  registerPanelExtensionAssetRoutes(app, { store, workspaceManager: {
    ownsLocation: async (id, location) => id === "first" && location.directory === "/first",
    getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/first" } }) }, rpc: { call: async ({ method, input }: any) => {
      assetReads++; if (holdAssets) await holdAssets()
      return { output: method === "assets" ? { status: "page", entries: input.sessionID === "session-a" ? [{ name: "Native image", mime: "image/png", tool: "mcp.paint", available: true,
        target: { messageID: "m", part: 0, index: 0, digest: "a".repeat(64) } }] : [], cursor: null } : { status: "asset", mime: "image/png", uri: assetUri } }
    } } }) as any,
  } })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: path.join(root, "vite"),
    plugins: [solid(), { name: "extension-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/panel-extensions.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: { "/api/panel-extensions": address } },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  const imagePage = await browser.newPage()
  assetUri = await imagePage.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 500; canvas.height = 300; return canvas.toDataURL("image/png") })
  await imagePage.close()
})
after(async () => { await browser?.close(); await server?.close(); await app.close(); await rm(root, { recursive: true, force: true }) })

async function page(locale = "en-US", drawer = false) {
  const page = await browser.newPage({ locale })
  page.on("pageerror", error => console.error("Extension fixture:", error.message))
  let uiState: Record<string, unknown> = {}
  await page.addInitScript(() => {
    ;(window as any).EventSource = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} close() {} }
  })
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.startsWith("/api/panel-extensions")) return route.continue()
    if (pathname === "/api/storage/state/ui") {
      if (route.request().method() === "PATCH") uiState = { ...uiState, ...route.request().postDataJSON() }
      return route.fulfill({ json: uiState })
    }
    if (pathname.includes("/settings/")) return route.fulfill({ json: { locale: "en" } })
    return route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [], outline: [] } })
  })
  await page.goto(`${url}${drawer ? "?drawer=1" : ""}`)
  await page.waitForFunction(() => Boolean((window as any).extensionFixture))
  return page
}
async function changed(page: Page) { await page.evaluate(() => (window as any).extensionFixture.changed()) }
async function openManager(view: Page, drawer = false) {
  // SUID's existing temporary Modal marks its own portal wrapper aria-hidden.
  // Still use real pointer hit-testing; the extension dialog is outside that wrapper.
  if (!await view.locator(".right-panel-customization-popover").count()) await view.getByRole("button", { name: "Customize right panel", includeHidden: drawer }).click()
  const disclosure = view.locator(".panel-extension-disclosure")
  if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await disclosure.locator("summary").click()
  await view.locator(".panel-extension-manager").waitFor()
}
async function installDirect(html: string) {
  const pkg = await readPanelExtensionArchive(fixtureArchive(html))
  await store.install(pkg)
  await store.activate(pkg.manifest.id, pkg.digest, true)
  return pkg
}
async function setAddonEnabled(view: Page, enabled: boolean) {
  const popup = view.getByRole("group", { name: "Customize right panel", exact: true })
  if (!await popup.count()) await view.getByRole("button", { name: "Customize right panel", exact: true }).click()
  await popup.getByRole("checkbox", { name: "Session example", exact: true }).click()
  await view.waitForFunction(enabled => [...document.querySelectorAll(".right-panel-customization-label")].some(label => {
    const input = label.querySelector("input")
    return label.textContent === "Session example" && input?.checked === enabled && !input.disabled
  }), enabled)
}

test("online catalogue lists without downloading code; explicit consent installs an addon tab", async () => {
  const view = await page(), before = archiveRequests
  try {
    await openManager(view)
    const catalogue = view.getByRole("region", { name: "Panel extensions" })
    await catalogue.getByRole("group", { name: "Session example", exact: true }).waitFor()
    assert.equal(await catalogue.getByText("A catalogue example", { exact: true }).count(), 0, "Descriptions stay off the list")
    assert.equal(archiveRequests, before)
    await catalogue.getByRole("searchbox", { name: "Search extensions" }).fill("no-such-addon")
    await catalogue.getByText("No matching extensions.").waitFor()
    await catalogue.getByRole("searchbox", { name: "Search extensions" }).fill("session")
    await catalogue.getByRole("button", { name: "Install…", exact: true }).click()
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).waitFor()
    assert.deepEqual(await store.list(), [])
    assert.equal(archiveRequests, before + 1)
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).check()
    await view.getByRole("button", { name: "Install disabled", exact: true }).click()
    await view.getByRole("group", { name: "Session example", exact: true }).waitFor()
    assert.equal(await catalogue.getByRole("group", { name: "Session example", exact: true }).count(), 1, "Installed catalogue entry appears once")
    assert.equal(await catalogue.getByRole("checkbox").count(), 0)
    await setAddonEnabled(view, true)
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-a" }).waitFor()
    assert.equal(archiveRequests, before + 2, "Install re-reads the approved package")
    await store.remove(fixtureManifest.id, onlineDigest)
  } finally { await view.close() }
})

test("withdrawn online selection cannot install after its trust preview was approved", async () => {
  const view = await page()
  try {
    await openManager(view)
    await view.getByRole("region", { name: "Panel extensions" }).getByRole("button", { name: "Install…", exact: true }).click()
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).check()
    catalogEntries = []
    await view.getByRole("button", { name: "Install disabled", exact: true }).click()
    await view.getByRole("alert").filter({ hasText: "Extension unavailable" }).waitFor()
    assert.deepEqual(await store.list(), [])
  } finally { catalogEntries = [onlineEntry]; await view.close() }
})

test("incompatible catalogue entries stay unselectable and offline discovery does not block ZIP installation", async () => {
  catalogEntries = [onlineEntry, { ...onlineEntry, manifest: { ...fixtureManifest, id: "future.example", name: "Future panel", apiVersion: 99 } }]
  const view = await page(), before = archiveRequests
  try {
    await openManager(view)
    const catalogue = view.getByRole("region", { name: "Panel extensions" })
    await catalogue.getByRole("button", { name: "Refresh", exact: true }).click()
    await catalogue.getByRole("button", { name: "Incompatible (API 99)", exact: true }).waitFor()
    assert.equal(await catalogue.getByRole("button", { name: "Incompatible (API 99)", exact: true }).isDisabled(), true)
    assert.equal(archiveRequests, before)
    catalogOffline = true
    await catalogue.getByRole("button", { name: "Refresh", exact: true }).click()
    await catalogue.getByRole("alert").filter({ hasText: "Online catalogue unavailable" }).waitFor()
    assert.equal(await view.getByRole("button", { name: "Install from ZIP…" }).isDisabled(), false)
    await view.locator('input[type="file"]').setInputFiles({ name: "local.zip", mimeType: "application/zip", buffer: fixtureArchive(example) })
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).waitFor()
  } finally { catalogOffline = false; catalogEntries = [onlineEntry]; await view.close() }
})

test("manual ZIP consent, general activation across projects, context switch, revoke, replacement and removal use real routes", async () => {
  const view = await page()
  try {
    await openManager(view)
    await view.getByRole("button", { name: "Install from ZIP…" }).waitFor()
    await view.locator('input[type="file"]').setInputFiles({ name: "example.zip", mimeType: "application/zip", buffer: fixtureArchive(example) })
    await view.getByText("I trust this package and its author", { exact: true }).waitFor()
    assert.equal(await view.getByRole("button", { name: "Install disabled" }).isDisabled(), true)
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).check()
    await view.getByRole("button", { name: "Install disabled" }).click()
    await view.getByRole("group", { name: "Session example", exact: true }).waitFor()
    assert.equal(await view.getByRole("region", { name: "Panel extensions" }).getByRole("checkbox").count(), 0, "Management has no activation control")
    assert.equal(await view.getByRole("tab", { name: "Session example", exact: true }).count(), 0)
    await setAddonEnabled(view, true)
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-a" }).waitFor()
    await view.evaluate(() => (window as any).extensionFixture.session("session-b"))
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-b" }).waitFor()
    await view.screenshot({ path: path.join(root, "extension-panel.png") })
    await view.evaluate(() => (window as any).extensionFixture.instance("second"))
    await view.locator(".panel-extension-manager").waitFor({ state: "detached" })
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-b" }).waitFor()
    await view.evaluate(() => (window as any).extensionFixture.instance("first"))
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.locator('iframe[title="Session example"]').waitFor()
    const entry = (await store.list())[0]
    await setAddonEnabled(view, false)
    await view.locator('iframe[title="Session example"]').waitFor({ state: "detached" })
    assert.equal((await store.list())[0].enabled, false)
    await view.getByRole("group", { name: "Customize right panel", exact: true }).getByRole("button", { name: "Reset", exact: true }).click()
    assert.equal(await view.getByRole("checkbox", { name: "Session example", exact: true }).isChecked(), false, "Reset does not grant addon consent")
    await setAddonEnabled(view, true)
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.locator('iframe[title="Session example"]').waitFor()
    const replacement = await readPanelExtensionArchive(fixtureArchive(example, { version: "1.1.0" }))
    await store.install(replacement, entry.digest); await changed(view)
    await view.locator('iframe[title="Session example"]').waitFor({ state: "detached" })
    assert.equal((await store.list())[0].enabled, false)
    await view.getByRole("button", { name: "Customize right panel", exact: true }).click()
    assert.equal(await view.getByRole("checkbox", { name: "Session example", exact: true }).isChecked(), false, "Replacement stays available but disabled in customization")
    await store.remove(entry.manifest.id, replacement.digest); await changed(view)
    await view.getByRole("checkbox", { name: "Session example", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await store.list(), [])
  } finally { await view.close() }
})

test("the customization checkbox owns activation, ignores legacy hide flags and fails without optimistic consent or replay", async () => {
  const pkg = await installDirect(example)
  const view = await page()
  try {
    await view.evaluate(() => localStorage.setItem("opencode-session-right-panel-customization-v1", JSON.stringify({ hiddenTabIds: ["extension:example.session"] })))
    await view.reload()
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.locator("iframe").waitFor()
    await view.getByRole("button", { name: "Customize right panel", exact: true }).click()
    const checkbox = view.getByRole("checkbox", { name: "Session example", exact: true })
    assert.equal(await checkbox.isChecked(), true, "Legacy window-only hiding is not a second activation gate")
    let requests = 0, release!: () => Promise<void>, started!: () => void
    const pending = new Promise<void>(resolve => { started = resolve })
    await view.route("**/api/panel-extensions/example.session", async route => {
      if (route.request().method() !== "PATCH") return route.continue()
      requests++
      release = () => route.fulfill({ status: 503, json: { error: "unavailable" } })
      started()
    })
    await checkbox.focus(); await view.keyboard.press("Space"); await pending
    assert.equal(await checkbox.isChecked(), true, "Pending mutation never changes approved state")
    assert.equal(await checkbox.isDisabled(), true)
    await release()
    await view.getByRole("alert").filter({ hasText: "Extension unavailable" }).waitFor()
    assert.equal(await checkbox.isChecked(), true)
    assert.equal(await checkbox.isDisabled(), false)
    assert.equal(requests, 1, "Failed mutation is not replayed")
    assert.equal((await store.list())[0].enabled, true)
    await view.unroute("**/api/panel-extensions/example.session")
    await setAddonEnabled(view, false)
    await view.locator("iframe").waitFor({ state: "detached" })
    await view.reload()
    await view.getByRole("button", { name: "Customize right panel", exact: true }).click()
    await checkbox.waitFor()
    assert.equal(await checkbox.isChecked(), false, "General deactivation survives reload")
    await view.evaluate(() => (window as any).extensionFixture.transport("disconnected"))
    assert.equal(await checkbox.isDisabled(), true, "Unverified state cannot activate code")
  } finally { await view.close(); await store.remove(pkg.manifest.id, pkg.digest) }
})

test("removal consent cannot follow a package replaced by another window", async () => {
  const first = await installDirect(example)
  const view = await page()
  try {
    await openManager(view)
    await view.getByRole("button", { name: "Remove…", exact: true }).click()
    await view.getByRole("button", { name: "Confirm removal", exact: true }).waitFor()
    const replacement = await readPanelExtensionArchive(fixtureArchive(example, { version: "1.1.0" }))
    await store.install(replacement, first.digest); await changed(view)
    await view.getByText("Session example 1.1.0", { exact: true }).waitFor()
    assert.equal(await view.getByRole("button", { name: "Confirm removal", exact: true }).count(), 0)
    assert.equal((await store.list())[0].digest, replacement.digest)
    await view.getByRole("button", { name: "Remove…", exact: true }).click()
    await view.getByRole("button", { name: "Confirm removal", exact: true }).click()
    await view.getByRole("button", { name: "Remove…", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await store.list(), [])
  } finally { await view.close() }
})

test("Extensions is separated, collapsed by default and combines installed/online rows without modes or a floating window", async () => {
  const pkg = await installDirect(example)
  const view = await page()
  let catalogReads = 0
  await view.route("**/api/panel-extensions/catalog*", route => { catalogReads++; return route.continue() })
  try {
    await view.getByRole("button", { name: "Customize right panel" }).click()
    const popup = view.getByRole("group", { name: "Customize right panel", exact: true })
    const summary = popup.locator(".panel-extension-disclosure > summary")
    await summary.waitFor()
    assert.equal(await summary.innerText(), "Extensions")
    assert.equal(await popup.locator(".panel-extension-divider").count(), 1)
    assert.equal(await popup.locator(".panel-extension-manager, input[type=search]").count(), 0)
    assert.equal(catalogReads, 0, "Opening customization does not load the online catalogue")
    const size = await summary.boundingBox()
    assert.ok(size && size.height <= 40, "Collapsed extension section occupies one compact line")
    const captures = process.env.CODENOMAD_PANEL_CAPTURE_DIR
    if (captures) { await mkdir(captures, { recursive: true }); await popup.screenshot({ path: path.join(captures, "extensions-popup.png") }) }
    await summary.click()
    const manager = popup.getByRole("region", { name: "Panel extensions", exact: true })
    await manager.getByRole("searchbox").waitFor()
    await view.waitForFunction(() => document.querySelector(".panel-extension-manager")?.getAttribute("aria-busy") === "false")
    assert.equal(await view.getByRole("dialog").count(), 0)
    assert.ok(catalogReads > 0, "Expanding loads metadata, not author code")
    assert.equal(await manager.getByRole("button", { name: "Installed extensions", exact: true }).count(), 0)
    assert.equal(await manager.getByRole("button", { name: "Available online", exact: true }).count(), 0)
    const row = manager.getByRole("group", { name: "Session example", exact: true })
    assert.equal(await row.count(), 1, "Installed catalogue entries are deduplicated")
    for (const button of await manager.locator(".window-icon-button").all()) {
      const bounds = (await button.boundingBox())!
      assert.ok(bounds.width >= 24 && bounds.height >= 24, "Shared control context retains accessible icon targets")
    }
    assert.ok((await row.boundingBox())!.height <= 44, "Installed addons use single-line rows")
    if (captures) await popup.screenshot({ path: path.join(captures, "extensions-expanded.png") })
    await manager.locator(".panel-extension-name").focus()
    await view.getByRole("tooltip").filter({ hasText: "A catalogue example" }).waitFor()
    await manager.getByRole("searchbox").fill("no-such-addon")
    await manager.getByRole("status").filter({ hasText: "No matching extensions." }).waitFor()
    await manager.getByRole("searchbox").fill("")
    await view.setViewportSize({ width: 390, height: 600 })
    await view.evaluate(() => (window as any).extensionFixture.theme("dark"))
    await view.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark")
    const bounds = (await popup.boundingBox())!
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 600)
    assert.equal(await popup.evaluate(element => element.scrollWidth <= element.clientWidth), true)
    if (captures) await popup.screenshot({ path: path.join(captures, "extensions-narrow-dark.png") })
    await summary.click()
    await manager.waitFor({ state: "detached" })
    await summary.click()
    await manager.getByRole("searchbox").waitFor()
    await view.keyboard.press("Escape")
    await popup.waitFor({ state: "detached" })
    await view.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Customize right panel")
    await view.getByRole("button", { name: "Customize right panel" }).click()
    assert.equal(await manager.count(), 0, "Reopening starts collapsed")
    await summary.click()
    // Ordinary popup outside gestures close and dispose management.
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await popup.waitFor({ state: "detached" })
    await openManager(view)
    await view.evaluate(() => (window as any).extensionFixture.instance("second"))
    await popup.waitFor({ state: "detached" })
    await openManager(view)
    await view.evaluate(() => (window as any).extensionFixture.active(false))
    await popup.waitFor({ state: "detached" })
  } finally { await view.close(); await store.remove(pkg.manifest.id, pkg.digest) }
})

test("API2 grants only current-session asset pages and bounded thumbnails; session switches and revocation fence late reads", async () => {
  const html = `<p id="result"></p><p id="palette"></p><img id="image"><script>
    let session;
    codenomad.onContext(async context => {
      document.querySelector('#palette').textContent = context.colors.background;
      if(session === context.sessionId) return; session = context.sessionId;
      const page = await codenomad.assets.list();
      document.querySelector('#result').textContent = context.sessionId + ':' + page.entries.length;
      if(page.entries.length) {window.readThumbnail=async()=>{const asset = await codenomad.assets.read(page.entries[0].target,{thumbnail:true});document.querySelector('#image').src=asset.uri;};await window.readThumbnail();}
    });
  </script>`
  const pkg = await readPanelExtensionArchive(fixtureArchive(html, { apiVersion: 2, permissions: ["session.context", "session.assets.read"] }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const view = await page()
  let release: (() => void) | undefined
  try {
    await view.getByRole("tab", { name: "Status", exact: true }).click()
    await view.locator(".right-panel-accordion-item").first().waitFor()
    const nativeBackground = await view.locator(".right-panel-accordion-item").first().evaluate(element => getComputedStyle(element).backgroundColor)
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    const frame = view.frameLocator("iframe[title='Session example']")
    await frame.locator("#result").filter({ hasText: "session-a:1" }).waitFor()
    await frame.locator("#image[src]").waitFor()
    await frame.locator("#image").evaluate(async image => { await (image as HTMLImageElement).decode() })
    assert.ok(await frame.locator("#image").evaluate(image => (image as HTMLImageElement).naturalWidth <= 256 && (image as HTMLImageElement).naturalHeight <= 256))
    assert.equal(await view.locator("iframe").evaluate(frame => getComputedStyle(frame).backgroundColor), nativeBackground, "Addon canvas matches native panel sections")
    await view.evaluate(() => document.documentElement.style.setProperty("--surface-secondary", "#123456"))
    await frame.locator("#palette").filter({ hasText: "#123456" }).waitFor()
    assert.equal(await view.locator("iframe").evaluate(frame => getComputedStyle(frame).backgroundColor), "rgb(18, 52, 86)")
    const ordinaryUri = assetUri
    assetUri = await view.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 800; return canvas.toDataURL("image/png") })
    await frame.locator("body").evaluate(() => (window as any).readThumbnail())
    await frame.locator("#image").evaluate(async image => { await (image as HTMLImageElement).decode() })
    assert.deepEqual(await frame.locator("#image").evaluate(image => [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight]), [3, 256], "Tall source keeps its aspect without a 25,600px intermediate")
    assetUri = await view.evaluate(uri => {
      const bytes = Uint8Array.from(atob(uri.split(",")[1]), char => char.charCodeAt(0))
      new DataView(bytes.buffer).setUint32(16, 8193)
      return "data:image/png;base64," + btoa(String.fromCharCode(...bytes))
    }, assetUri)
    await view.evaluate(() => {
      const decode = window.createImageBitmap
      ;(window as any).bitmapCalls = 0
      window.createImageBitmap = ((...args: Parameters<typeof decode>) => { (window as any).bitmapCalls++; return decode(...args) }) as typeof decode
    })
    assert.equal(await frame.locator("body").evaluate(async () => { try { await (window as any).readThumbnail(); return false } catch { return true } }), true)
    assert.equal(await view.evaluate(() => (window as any).bitmapCalls), 0, "Oversized source is rejected before entering a browser decoder")
    assetUri = ordinaryUri
    const before = assetReads
    let started!: () => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    holdAssets = () => new Promise<void>(resolve => { release = resolve; started() })
    await frame.locator("body").evaluate(() => { void (window as any).codenomad.assets.list().catch(() => {}) })
    await admitted
    assert.ok(assetReads > before)
    holdAssets = undefined
    await view.evaluate(() => (window as any).extensionFixture.session("session-b"))
    release?.()
    await frame.locator("#result").filter({ hasText: "session-b:0" }).waitFor()
    assert.equal(await frame.locator("#image").getAttribute("src"), null, "Previous session pixels are not retained")
    await store.activate(pkg.manifest.id, pkg.digest, false); await changed(view)
    await view.locator("iframe[title='Session example']").waitFor({ state: "detached" })
  } finally { holdAssets = undefined; release?.(); await view.close(); await store.remove(pkg.manifest.id, pkg.digest) }
})

test("API2 observes failed/pruned assets and fences native disconnects and connection generations", async () => {
  const pkg = await readPanelExtensionArchive(fixtureArchive(`<p id="changes">0</p><p id="state"></p><script>
    let changes=0; codenomad.assets.onChanged(()=>document.querySelector('#changes').textContent=++changes);
    window.probe=()=>{document.querySelector('#state').textContent='pending';void codenomad.assets.list().then(()=>document.querySelector('#state').textContent='success').catch(()=>document.querySelector('#state').textContent='error');};
  </script>`, { apiVersion: 2, permissions: ["session.context", "session.assets.read"] }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const view = await page()
  try {
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    const frame = view.frameLocator("iframe[title='Session example']")
    await frame.locator("#changes").waitFor()
    const status = (status: string, generation: number, instanceId = "first") => view.evaluate(event => (window as any).extensionFixture.event(event), {
      type: "instance.eventStatus", instanceId, status, generation,
    })
    await status("connected", 1)
    await frame.locator("#changes").filter({ hasText: /^1$/ }).waitFor()
    for (const [index, type] of ["session.tool.failed", "rpc.codenomad.session-pruning.pruned"].entries()) {
      await view.evaluate(type => (window as any).extensionFixture.event({ type: "instance.event", instanceId: "first", event: { type, data: { sessionID: "session-a" } } }), type)
      await frame.locator("#changes").filter({ hasText: new RegExp(`^${index + 2}$`) }).waitFor()
    }
    await view.evaluate(() => {
      const fetch = window.fetch, post = MessagePort.prototype.postMessage
      ;(window as any).assetResults = []
      MessagePort.prototype.postMessage = function (value, ...args: any[]) {
        if (value?.type === "assets:result") (window as any).assetResults.push(value)
        return (post as any).call(this, value, ...args)
      }
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if ((window as any).holdAsset && String(input).endsWith("/assets")) {
          ;(window as any).holdAsset = false
          ;(window as any).assetSignal = init?.signal
          // Deliberately ignore abort to exercise the publication fence, not just fetch cancellation.
          return new Promise<Response>(resolve => { (window as any).releaseAsset = () => resolve(new Response(JSON.stringify({ status: "page", entries: [], cursor: null }))) })
        }
        return fetch(input, init)
      }) as typeof window.fetch
    })
    for (const generation of [2, 3]) {
      await view.evaluate(() => { (window as any).holdAsset = true; (window as any).assetSignal = null })
      await frame.locator("body").evaluate(() => (window as any).probe())
      await view.waitForFunction(() => Boolean((window as any).assetSignal))
      await status("error", generation, "second")
      assert.equal(await view.evaluate(() => (window as any).assetSignal.aborted), false, "Other instances do not cancel this channel")
      if (generation === 2) {
        await status("error", 1)
        assert.equal(await view.evaluate(() => (window as any).assetSignal.aborted), true)
        await frame.locator("body").evaluate(() => (window as any).probe())
        await frame.locator("#state").filter({ hasText: /^error$/ }).waitFor()
      }
      await status("connected", generation)
      assert.equal(await view.evaluate(() => (window as any).assetSignal.aborted), true, "Generation replacement fences even without an error event")
      await frame.locator("#changes").filter({ hasText: new RegExp(`^${generation + 2}$`) }).waitFor()
      const before = await view.evaluate(() => (window as any).assetResults.filter((value: any) => value.result).length)
      await view.evaluate(() => (window as any).releaseAsset())
      await frame.locator("body").evaluate(() => (window as any).probe())
      await frame.locator("#state").filter({ hasText: /^success$/ }).waitFor()
      assert.equal(await view.evaluate(() => (window as any).assetResults.filter((value: any) => value.result).length), before + 1, "Only the new native connection publishes a successful result")
    }
  } finally { await view.evaluate(() => (window as any).releaseAsset?.()).catch(() => {}); await view.close(); await store.remove(pkg.manifest.id, pkg.digest) }
})

test("inline management and keyboard tooltips work inside the real temporary drawer", async () => {
  const view = await page("en-US", true)
  try {
    await view.setViewportSize({ width: 390, height: 600 })
    await openManager(view, true)
    const manager = view.locator(".panel-extension-manager")
    await manager.locator("input[type=search]").fill("session")
    const name = manager.locator(".panel-extension-name")
    await name.focus()
    await view.getByRole("tooltip").filter({ hasText: "A catalogue example" }).waitFor()
    assert.equal(await name.evaluate(element => element === document.activeElement), true)
    await manager.getByRole("button", { name: "Install…", exact: true, includeHidden: true }).click()
    await manager.getByRole("checkbox", { name: "I trust this package and its author", includeHidden: true }).waitFor()
    await view.keyboard.press("Escape")
    await manager.waitFor({ state: "detached" })
  } finally { await view.close() }
})

test("localized managers have no duplicate activation and keep actions reachable at narrow dark widths", async () => {
  const pkg = await installDirect(example)
  try {
    for (const locale of ["fr-FR", "he-IL", "ja-JP", "es-ES"]) {
      const view = await page(locale)
      try {
        await view.setViewportSize({ width: 390, height: 600 })
        await view.waitForFunction(language => document.documentElement.lang === language, locale.split("-")[0])
        await view.evaluate(() => (window as any).extensionFixture.theme("dark"))
        await view.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark")
        await view.locator(".right-panel-tab-bar .icon-toggle").click()
        const popup = view.locator(".right-panel-customization-popover")
        const captures = process.env.CODENOMAD_PANEL_CAPTURE_DIR
        if (captures) await popup.screenshot({ path: path.join(captures, `extensions-popup-${locale}.png`) })
        await popup.locator(".panel-extension-disclosure > summary").click()
        const manager = popup.locator(".panel-extension-manager")
        await manager.waitFor()
        for (const width of [390, 320]) {
          await view.setViewportSize({ width, height: 600 })
          assert.equal(await popup.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${locale} ${width}: no popup overflow`)
          const bounds = (await popup.boundingBox())!
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 600)
          const row = manager.locator(".panel-extension-row")
          assert.ok((await row.boundingBox())!.height <= 44)
          assert.equal(await manager.getByRole("checkbox").count(), 0)
          for (const button of await manager.locator(".panel-extension-search-row button").all()) {
            const bounds = (await button.boundingBox())!
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${locale} ${width}: toolbar action inside viewport`)
          }
          const zip = manager.locator(".panel-extension-zip")
          const chooser = view.waitForEvent("filechooser")
          await zip.click()
          await (await chooser).setFiles([])
          if (captures) await popup.screenshot({ path: path.join(captures, `extensions-installed-${locale}-${width}.png`) })
        }
      } finally { await view.close() }
    }
  } finally { await store.remove(pkg.manifest.id, pkg.digest) }
})

test("author code cannot access parent DOM/storage, native bridges, network APIs, nested frames or global RPC", async () => {
  const pkg = await installDirect(`<p id="security"></p><script>
    const checks = {};
    for (const [name, operation] of Object.entries({ parent: () => parent.document.body, storage: () => localStorage.getItem('secret'), cookie: () => document.cookie })) {
      try { operation(); checks[name] = 'allowed'; } catch { checks[name] = 'blocked'; }
    }
    checks.electron = typeof window.electronAPI; checks.tauri = typeof window.__TAURI_INTERNALS__;
    parent.postMessage({ type: 'rpc', method: 'runCommand', input: 'malicious' }, '*');
    fetch('/api/panel-extensions').then(() => checks.network = 'allowed').catch(() => checks.network = 'blocked').finally(() => document.querySelector('#security').textContent = JSON.stringify(checks));
  </script>`)
  const view = await page()
  try {
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    const output = view.frameLocator('iframe[title="Session example"]').locator("#security")
    await output.filter({ hasText: '"network":"blocked"' }).waitFor()
    assert.deepEqual(JSON.parse(await output.innerText()), { parent: "blocked", storage: "blocked", cookie: "blocked", electron: "undefined", tauri: "undefined", network: "blocked" })
    assert.equal(await view.locator("iframe").getAttribute("sandbox"), "allow-scripts")
    await store.remove(pkg.manifest.id, pkg.digest)
  } finally { await view.close() }
})

test("late panel reads cannot publish into a different session or survive hidden/reconnected demand", async () => {
  const pkg = await installDirect(example)
  const view = await page()
  try {
    let release!: () => Promise<void>, started!: () => void
    const pending = new Promise<void>(resolve => { started = resolve })
    await view.route("**/api/panel-extensions/*/panel?*", async route => {
      const response = await route.fetch(); release = () => route.fulfill({ response }); started()
    }, { times: 1 })
    await view.getByRole("tab", { name: "Session example", exact: true }).click(); await pending
    await view.evaluate(() => (window as any).extensionFixture.session("session-new"))
    const context = view.frameLocator('iframe[title="Session example"]').locator("#context")
    await context.filter({ hasText: "session-new" }).waitFor()
    await release()
    assert.match(await context.innerText(), /session-new/)
    await view.evaluate(() => (window as any).extensionFixture.transport("disconnected"))
    await view.locator("iframe").waitFor({ state: "detached" })
    await changed(view)
    assert.equal(await view.locator("iframe").count(), 0)
    await view.evaluate(() => (window as any).extensionFixture.transport("connected"))
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-new" }).waitFor()
    await view.evaluate(() => (window as any).extensionFixture.active(false))
    await view.locator("iframe").waitFor({ state: "detached" })
    await store.remove(pkg.manifest.id, pkg.digest)
  } finally { await view.close() }
})
