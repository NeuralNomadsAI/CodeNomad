import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "multiserver-project-names", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/multiserver-project-names.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const host of ["electron", "tauri"]) test(`${host} rename dialog keeps its initiating server when selection changes or its tab disappears`, async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(host => {
    const win = window as any
    win.__name = Object
    win.__CODENOMAD_RUNTIME_HOST__ = host
    win.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    win.EventSource = class extends EventTarget { close() {} }
  }, host)
  let state: any = { recentFolders: ["local-shared", "A", "B"].map(serverId => ({ serverId, path: "D:/same", lastAccessed: 1 })) }
  await page.route(/\/(?:api|workspaces)\//, async route => {
    if (new URL(route.request().url()).pathname === "/api/storage/state/ui") {
      if (route.request().method() === "PATCH") state = { ...state, ...route.request().postDataJSON() }
      return route.fulfill({ json: state })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url)
    await page.locator('[data-app-tab-id="instance:a1"] [role="tab"]').dblclick()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    await dialog.getByRole("textbox").fill("Canceled name")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.equal((await page.evaluate(() => (window as any).renameFixture.names())).a1, "a1")
    await page.locator('[data-app-tab-id="instance:a1"] [role="tab"]').dblclick()
    await dialog.waitFor()
    await page.evaluate(() => (window as any).renameFixture.select("b"))
    await dialog.getByRole("textbox").fill("Intended A name")
    await dialog.getByRole("button", { name: "Rename", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as any).renameFixture.names()), {
      local: "local", a1: "Intended A name", a2: "Intended A name", b: "b", alias: "alias",
    })
    assert.deepEqual(state.recentFolders.map((entry: any) => entry.projectName), [undefined, "Intended A name", undefined])

    await page.locator('[data-app-tab-id="instance:a1"] [role="tab"]').dblclick()
    await dialog.waitFor()
    await page.evaluate(() => {
      const fixture = (window as any).renameFixture
      fixture.remove("a1"); fixture.remove("a2"); fixture.select("local")
    })
    await dialog.getByRole("textbox").fill("Orphan A name")
    await dialog.getByRole("button", { name: "Rename", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as any).renameFixture.names()), { local: "local", b: "b", alias: "alias" })
    assert.deepEqual(state.recentFolders.map((entry: any) => entry.projectName), [undefined, "Orphan A name", undefined])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
