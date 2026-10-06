import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
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

const app = Fastify()
let server: ViteDevServer, browser: Browser, url: string, root: string, store: PanelExtensionStore
const example = `<style>body { font: 14px system-ui; color: #222; background: #fff; }</style><p id="context"></p><script>
  codenomad.onContext(context => document.querySelector('#context').textContent = context.sessionId + ' · ' + context.locale + ' · ' + context.appearance);
</script>`
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencode-panel-browser-"))
  store = new PanelExtensionStore(root)
  registerPanelExtensionRoutes(app, { store, workspaceManager: { get: id => ["first", "second"].includes(id) ? { id, path: `/${id}` } as any : undefined } })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
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
})
after(async () => { await browser?.close(); await server?.close(); await app.close(); await rm(root, { recursive: true, force: true }) })

async function page() {
  const page = await browser.newPage({ locale: "en-US" })
  await page.addInitScript(() => {
    ;(window as any).EventSource = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} close() {} }
  })
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.startsWith("/api/panel-extensions")) return route.continue()
    if (pathname.includes("/settings/")) return route.fulfill({ json: { locale: "en" } })
    return route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [], outline: [] } })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).extensionFixture))
  return page
}
async function changed(page: Page) { await page.evaluate(() => (window as any).extensionFixture.changed()) }
async function installDirect(html: string) {
  const pkg = await readPanelExtensionArchive(fixtureArchive(html))
  await store.install(pkg)
  await store.activate(pkg.manifest.id, pkg.digest, "/first", "project", true)
  return pkg
}

test("manual ZIP consent, scoped tab, context switch, revoke, replacement and removal use real routes", async () => {
  const view = await page()
  try {
    await view.getByRole("button", { name: "Customize right panel" }).click()
    await view.getByRole("button", { name: "Install from ZIP…" }).waitFor()
    await view.locator('input[type="file"]').setInputFiles({ name: "example.zip", mimeType: "application/zip", buffer: fixtureArchive(example) })
    await view.getByText("I trust this package and its author", { exact: true }).waitFor()
    assert.equal(await view.getByRole("button", { name: "Install disabled" }).isDisabled(), true)
    await view.getByRole("checkbox", { name: "I trust this package and its author" }).check()
    await view.getByRole("button", { name: "Install disabled" }).click()
    await view.getByRole("checkbox", { name: "This folder", exact: true }).waitFor()
    assert.equal(await view.getByRole("tab", { name: "Session example", exact: true }).count(), 0)
    await view.getByRole("checkbox", { name: "This folder", exact: true }).check()
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-a" }).waitFor()
    await view.evaluate(() => (window as any).extensionFixture.session("session-b"))
    await view.frameLocator('iframe[title="Session example"]').locator("#context").filter({ hasText: "session-b" }).waitFor()
    await view.screenshot({ path: path.join(root, "extension-panel.png") })
    await view.evaluate(() => (window as any).extensionFixture.instance("second"))
    await view.getByRole("tab", { name: "Session example", exact: true }).waitFor({ state: "detached" })
    assert.equal(await view.locator("iframe").count(), 0)
    await view.evaluate(() => (window as any).extensionFixture.instance("first"))
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.locator('iframe[title="Session example"]').waitFor()
    const entry = (await store.list("/first"))[0]
    await store.activate(entry.manifest.id, entry.digest, "/first", "project", false); await changed(view)
    await view.locator('iframe[title="Session example"]').waitFor({ state: "detached" })
    await store.activate(entry.manifest.id, entry.digest, "/first", "global", true); await changed(view)
    await view.getByRole("tab", { name: "Session example", exact: true }).click()
    await view.locator('iframe[title="Session example"]').waitFor()
    const replacement = await readPanelExtensionArchive(fixtureArchive(example, { version: "1.1.0" }))
    await store.install(replacement, entry.digest); await changed(view)
    await view.locator('iframe[title="Session example"]').waitFor({ state: "detached" })
    assert.equal((await store.list("/second"))[0].enabled, false)
    await store.remove(entry.manifest.id, replacement.digest); await changed(view)
    assert.deepEqual(await store.list("/first"), [])
  } finally { await view.close() }
})

test("removal consent cannot follow a package replaced by another window", async () => {
  const first = await installDirect(example)
  const view = await page()
  try {
    await view.getByRole("button", { name: "Customize right panel" }).click()
    await view.getByRole("button", { name: "Remove…", exact: true }).click()
    await view.getByRole("button", { name: "Confirm removal", exact: true }).waitFor()
    const replacement = await readPanelExtensionArchive(fixtureArchive(example, { version: "1.1.0" }))
    await store.install(replacement, first.digest); await changed(view)
    await view.getByText("Session example 1.1.0", { exact: true }).waitFor()
    assert.equal(await view.getByRole("button", { name: "Confirm removal", exact: true }).count(), 0)
    assert.equal((await store.list("/first"))[0].digest, replacement.digest)
    await view.getByRole("button", { name: "Remove…", exact: true }).click()
    await view.getByRole("button", { name: "Confirm removal", exact: true }).click()
    await view.getByRole("button", { name: "Remove…", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await store.list("/first"), [])
  } finally { await view.close() }
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
