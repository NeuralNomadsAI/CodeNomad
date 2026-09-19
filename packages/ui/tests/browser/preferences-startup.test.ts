import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "preferences-startup", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'))
      })
    } }],
    resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture?preferences=chat`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const host of ["electron", "tauri"] as const) {
  test(`${host} Preferences starts without hydrating workspaces and loads only its explicit provider context`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const workspaceRequests: string[] = []
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript({ content: `{
      const host = ${JSON.stringify(host)}
      const w = window
      w.__CODENOMAD_RUNTIME_HOST__ = host
      w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
      w.fixtureRequest = { section: "chat", scrollTop: 300, instanceId: "current-project", location: { directory: "D:/current-project" } }
      w.fixtureEvents = []
      w.EventSource = class extends EventTarget {
        constructor() { super(); w.fixtureEvents.push(this) }
        close() {}
      }
      w.electronAPI = host === "electron" ? {
        getPreferencesRequest: async () => w.fixtureRequest,
        acceptPreferencesRequest: async (request) => { w.fixtureRequest = request },
        preferencesReady: async () => { w.fixtureReady = true },
        onPreferencesSection: () => () => {},
        onPreferencesCloseRequested: () => () => {},
        onPreferencesTransitionRequested: () => () => {},
      } : undefined
      if (host === "tauri") {
        w.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "preferences_get_request") return w.fixtureRequest
            if (command === "preferences_accept_request") w.fixtureRequest = args.request
            if (command === "preferences_window_ready") w.fixtureReady = true
            return 1
          },
        }
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      }
    }` })
    await page.route(/\/(?:api|workspaces)\//, async route => {
      const path = new URL(route.request().url()).pathname
      if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
      if (path.includes("/workspaces")) workspaceRequests.push(route.request().url())
      const body = path === "/api/workspaces" ? Array.from({ length: 20 }, (_, i) => ({
        id: `project-${i}`, path: `D:/project-${i}`, status: "ready", port: 1234,
        proxyPath: `/workspaces/project-${i}/instance`, binaryId: "fixture", binaryLabel: "fixture",
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      })) : path === "/api/storage/config/ui" ? { settings: { locale: "en" } }
        : path.includes("/instance/api/") ? [] : {}
      await route.fulfill({ json: body })
    })
    try {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).fixtureReady)
      await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")?.scrollTop === 300)
      assert.deepEqual(workspaceRequests, [], "startup must not load the project inventory")

      // Both reconnect reconciliation and live workspace events used to start
      // full session/catalog hydration in this secondary renderer.
      await page.evaluate(() => {
        for (const source of (window as any).fixtureEvents) {
          source.onopen?.(new Event("open"))
          for (let i = 0; i < 20; i++) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            type: "workspace.started", workspace: { id: `project-${i}`, path: `D:/project-${i}`, status: "ready", port: 1234 },
          }) }))
          source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            type: "storage.configChanged", owner: "ui", value: { settings: { locale: "fr" } },
          }) }))
        }
      })
      await page.getByRole("button", { name: "Fournisseurs", exact: true }).waitFor()
      assert.deepEqual(workspaceRequests, [], "reconnect/events must not hydrate unrelated projects")
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/integration")),
        page.getByRole("button", { name: "Fournisseurs", exact: true }).click(),
      ])
      assert.equal(workspaceRequests.length, 3)
      for (const request of workspaceRequests) {
        const target = new URL(request)
        assert.match(target.pathname, /^\/workspaces\/current-project\/instance\/api\/(provider|model|integration)$/)
        assert.equal(target.searchParams.get("location[directory]"), "D:/current-project")
      }
      assert.deepEqual(errors, [])
    } catch (error) {
      console.error({ host, errors, workspaceRequests, content: (await page.locator("body").innerText()).slice(0, 500) })
      throw error
    } finally { await page.close() }
  })
}
