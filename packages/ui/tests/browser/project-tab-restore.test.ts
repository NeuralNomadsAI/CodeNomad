import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "project-tab-restore", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-tab-restore.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const host of ["electron", "tauri"] as const) for (const userSelection of [false, true]) {
test(`${host} restores the active project before session hydration${userSelection ? " and respects a subsequent user selection" : ""}`, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    window.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)}
    window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'
    window.EventSource = class extends EventTarget { close() {} }
    const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
      activeTabIndex: 1, tabs: ['D:/first', 'D:/second'].map(folder => ({
        kind: 'workspace', folder, occurrence: 0, activeSessionId: 'saved-session', activeParentSessionId: 'saved-session',
        drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      }))
    } }
    window.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot }),
      saveClientState: async (_token, value) => { window.savedSnapshot = value; return true },
    }
    if (${JSON.stringify(host)} === 'tauri') {
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === 'client_state_load') return { isPrimary: true, restoreEnabled: true, snapshot }
          if (command === 'client_state_save') window.savedSnapshot = args.snapshot
          return true
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
  let releaseSessions!: () => void
  const sessionsReady = new Promise<void>(resolve => { releaseSessions = resolve })
  const projects: any[] = []
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
    let body: unknown = {}
    if (path === "/api/workspaces") {
      if (request.method() === "POST") {
        const input = request.postDataJSON()
        const id = input.path.endsWith("first") ? "first" : "second"
        body = { id, path: input.path, status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
          binaryId: "fixture", binaryLabel: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), requestId: input.requestId }
        projects.push(body)
      } else body = projects
    } else if (path.endsWith("/worktrees")) body = { worktrees: [] }
    else if (path.includes("/instance/api/")) {
      if (path.includes("/session")) {
        await sessionsReady
        if (path.endsWith("/saved-session")) return route.fulfill({ status: 404, json: { message: "Session no longer exists" } })
      }
      body = []
    }
    await route.fulfill({ json: body })
  })
  try {
    await page.goto(url)
    const selected = page.getByRole("tab", { name: "D:/second", exact: true })
    await selected.waitFor()
    assert.equal(await selected.getAttribute("aria-selected"), "true", "project selection must not wait for its conversation requests")
    if (userSelection) await page.getByRole("tab", { name: "D:/first", exact: true }).click()
    releaseSessions()
    await page.locator('[data-restoring="false"]').waitFor()
    assert.equal(await page.getByRole("tab", { name: userSelection ? "D:/first" : "D:/second", exact: true }).getAttribute("aria-selected"), "true")
    await page.waitForFunction(index => (window as any).savedSnapshot?.session?.activeTabIndex === index, userSelection ? 0 : 1)
    assert.deepEqual(errors, [])
  } finally { releaseSessions(); await page.close() }
})
}
