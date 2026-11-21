import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright"
import { CODENOMAD_CAPABILITIES } from "../../../server/src/meta-contract"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let fixture: { browser: Awaited<ReturnType<typeof chromium.launch>>; url: string; close(): Promise<void> }
before(async () => {
  const page = await borrowFixture({ name: "backend-capabilities", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-capabilities.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  fixture = { browser, url: page.url, close: () => browser.close() }
})
after(async () => { await fixture?.close() })

const CORE = ["workspaces", "workspace-files", "workspace-git", "events"]
/** Routes of the optional families these surfaces would read at startup or on display. */
const OPTIONAL_ROUTES = /\/api\/(speech|opencode|sidecars|config-files|remote-control\/status|usage)\b|\/(background-shells|plugin-controls|integrations|service-usage|permission-mode)\b/
const HIDDEN = {
  blank: ["Clone repository", "Temporary tab", "New SideCar"],
  status: ["Permissions", "Background Shells", "Plugins"],
  settings: ["Voice", "Remote Access", "OpenCode", "Missions", "Stats", "SideCars", "Config Files"],
}

for (const [label, capabilities] of [["core families only", CORE], ["every family", [...CODENOMAD_CAPABILITIES]], ["no capability list", undefined]] as const) {
  test(`surfaces follow the host's declared route families: ${label}`, async () => {
    const page = await fixture.browser.newPage({ locale: "en-US", viewport: { width: 1900, height: 1000 } })
    const optional: string[] = [], errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
      await page.route(url => /^\/(api|workspaces)\//.test(url.pathname), route => {
        const url = new URL(route.request().url())
        if (OPTIONAL_ROUTES.test(url.pathname)) optional.push(url.pathname)
        if (url.pathname === "/api/meta") return route.fulfill({ json: { localUrl: "http://127.0.0.1:9899", listeningMode: "local",
          addresses: [], localRequest: true, serverId: "server-a", apiContract: 1, ...(capabilities ? { capabilities } : {}) } })
        return route.fulfill({ json: {} })
      })
      await page.goto(fixture.url)
      await page.locator("html[data-meta-settled]").waitFor({ state: "attached" })
        .catch(error => { throw new Error(`${error.message}\n${errors.join("\n")}`) })
      const speech = await page.evaluate(async () => {
        await (window as any).fixture.refreshOpenCodeSetup()
        return (await (window as any).fixture.loadSpeechCapabilities())?.available ?? null
      })
      const blank = page.locator("main"), status = page.locator("aside"), nav = page.locator(".settings-screen-nav-list")
      await nav.getByRole("button", { name: "General", exact: true }).waitFor()
      await status.getByText("Tokens", { exact: true }).waitFor()
      const visible = async (scope: typeof blank, name: string) => await scope.getByText(name, { exact: true }).count() > 0
      for (const [scope, names] of [[blank, HIDDEN.blank], [status, HIDDEN.status], [nav, HIDDEN.settings]] as const) {
        for (const name of names) assert.equal(await visible(scope, name), capabilities !== CORE, `${label}: ${name}`)
      }
      assert.equal(await blank.getByRole("button", { name: "Remote connect", exact: true }).count(), Number(capabilities !== CORE))
      if (capabilities === CORE) {
        assert.equal(speech, false, "an undeclared speech family reads as unavailable voice")
        assert.deepEqual(optional, [], "no request reaches an undeclared family")
      } else {
        assert.ok(optional.some(path => path.startsWith("/api/speech")) && optional.some(path => path.startsWith("/api/opencode")), optional.join())
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
