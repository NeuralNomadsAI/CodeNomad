import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"

let browser: Browser, url: string
before(async () => {
  prepareGitPrototypeAssets()
  const fixture = await borrowFixture({ name: "config-file-target", routes: [{ path: "/config", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/config-file-target.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const native of [false, true]) test(`${native ? "native Preferences hint" : "embedded opening"} selects only a catalogued config and supports reopening`, async () => {
  const page = await browser.newPage(), reads: string[] = [], writes: string[] = [], errors: string[] = [], resources: string[] = []
  page.setDefaultTimeout(20_000)
  page.on("pageerror", error => errors.push(error.message))
  page.on("response", response => { if (response.status() >= 400) resources.push(`${response.status()} ${response.url()}`) })
  try {
    const publicPath = fileURLToPath(new URL("../../src/renderer/public", import.meta.url))
    await page.context().route(new RegExp("^[^?#]*//[^/]+/monaco(/vs/|\\.worker\\.js)"),
      route => route.fulfill({ path: path.join(publicPath, decodeURIComponent(new URL(route.request().url()).pathname)) }))
    await page.route("**/api/**", route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() !== "GET") writes.push(path)
      if (path === "/api/config-files") return route.fulfill({ json: [
        { id: "first", label: "First config", path: "/config/first.jsonc", format: "jsonc" },
        { id: "responsible", label: "Responsible config", path: "/config/responsible.jsonc", format: "jsonc" },
      ] })
      if (path.startsWith("/api/config-files/")) {
        reads.push(path)
        return route.fulfill({ json: { contents: "{}\n", exists: true } })
      }
      return route.fulfill({ json: path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
    })
    await page.goto(url)
    await page.waitForFunction(() => (window as any).configTarget)
    const open = (id: string) => page.evaluate(({ id, native }) => (window as any).configTarget[native ? "native" : "open"](id), { id, native })
    await open("responsible")
    const selector = page.locator(".config-files-selector-trigger")
    await selector.filter({ hasText: "Responsible config" }).waitFor()
    assert.deepEqual(reads, ["/api/config-files/responsible/content"])
    await open("first"); await selector.filter({ hasText: "First config" }).waitFor()
    assert.equal(reads.at(-1), "/api/config-files/first/content")
    const count = reads.length
    await open("unknown")
    await page.waitForFunction(() => !(window as any).configTarget.pending())
    assert.equal(reads.length, count, "an absent server ID never becomes a file read")
    const editor = page.locator(".monaco-editor .view-lines").first()
    await editor.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press("Control+Home"); await page.keyboard.type(" ")
    await page.getByText("Unsaved changes", { exact: true }).waitFor()
    await open("responsible")
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    if (native) await page.evaluate(() => (window as any).configTarget.checkDiscard())
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click()
    if (native) await page.waitForFunction(() => (window as any).configTarget.discardResult === false)
    assert.match(await selector.innerText(), /First config/)
    assert.equal(reads.length, count, "cancel preserves the dirty file without loading the requested target")
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
  } catch (error) { throw new Error(`${error}\n${JSON.stringify({ errors, resources, editor: (await page.locator(".config-files-editor-shell").innerHTML()).slice(0, 1000) })}`) }
  finally { await page.close() }
})
