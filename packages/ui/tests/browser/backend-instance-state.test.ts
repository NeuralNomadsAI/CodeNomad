import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "project-tab-restore",
    routes: [{ path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/project-tab-restore.tsx\"></script></body></html>" }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const host of ["electron", "tauri"] as const) for (const savedRemote of [false, true]) {
  test(`${host} captures backend ids and preserves an unavailable backend without reopening locally (saved=${savedRemote})`, async () => {
    const page = await browser.newPage()
    const errors: string[] = [], creations: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript({ content: `{
      const w = window, host = ${JSON.stringify(host)}, savedRemote = ${savedRemote}
      w.__CODENOMAD_RUNTIME_HOST__ = host
      w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
      w.EventSource = class extends EventTarget { close() {} }
      const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
        activeTabIndex: savedRemote ? 0 : -1, tabs: savedRemote ? [{
          kind: "workspace", backendId: "lab", folder: "/same", occurrence: 0,
          drafts: { s1: "remote unsent draft" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        }] : [],
      } }
      const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot })
      w.electronAPI = {
        claimClientStateAccess: async () => true, loadClientState: async () => load(),
        saveClientState: async (_token, value) => { w.savedSnapshot = value; return true },
      }
      if (host === "tauri") {
        w.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "client_state_load") return load()
            if (command === "client_state_save") w.savedSnapshot = args.snapshot
            return true
          },
        }
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      }
    }` })
    await page.route(/\/(?:api|workspaces)\//, async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === "/api/workspaces" && request.method() === "POST") creations.push(request.postDataJSON().path)
      await route.fulfill({ json: path === "/api/workspaces" ? [] : {} })
    })
    try {
      await page.goto(url)
      await page.locator('[data-restoring="false"]').waitFor()
      if (!savedRemote) {
        await page.evaluate(async () => {
          const instanceModule = "/src/stores/instances.ts", tabModule = "/src/stores/app-tabs.ts"
          const { addInstance } = await import(instanceModule), { attachInstanceTab } = await import(tabModule)
          for (const [id, backendId] of [["w1", undefined], ["lab~w1", "lab"]]) {
            addInstance({ id, ...(backendId ? { backendId } : {}), folder: "/same", port: 0, pid: 0,
              proxyPath: `/workspaces/${id}`, status: "starting", client: null })
            attachInstanceTab(id)
          }
        })
        await page.waitForFunction(() => (window as any).savedSnapshot?.session?.tabs.length === 2)
        const tabs = await page.evaluate(() => (window as any).savedSnapshot.session.tabs)
        assert.deepEqual(tabs.map((tab: any) => [tab.backendId, tab.folder, tab.occurrence]),
          [[undefined, "/same", 0], ["lab", "/same", 0]])
      } else {
        await page.waitForFunction(() => (window as any).savedSnapshot?.session?.tabs.length === 1)
        const tab = await page.evaluate(() => (window as any).savedSnapshot.session.tabs[0])
        assert.equal(tab.backendId, "lab")
        assert.equal(tab.drafts.s1, "remote unsent draft")
        assert.equal(await page.getByRole("tab").count(), 0)
      }
      assert.deepEqual(creations, [], "no remote folder is opened on the local backend")
      assert.deepEqual(errors, [])
    } catch (error) {
      throw new Error(`Browser errors: ${JSON.stringify(errors)}; body: ${(await page.locator("body").innerText()).slice(0, 500)}`, { cause: error })
    } finally { await page.close() }
  })
}
