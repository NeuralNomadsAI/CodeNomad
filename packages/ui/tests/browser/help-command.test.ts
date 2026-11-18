import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let cache: Awaited<ReturnType<typeof createFixtureCache>>, browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "help-command",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/help-command.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { try { } finally { await cache?.dispose() } } })

const hostScript = (host: string, context: string) => `
    const host = ${JSON.stringify(host)}
    window.__CODENOMAD_RUNTIME_HOST__ = host
    window.__CODENOMAD_WINDOW_CONTEXT__ = ${JSON.stringify(context)}
    window.opened = []
    window.open = (...args) => { window.opened.push(args); return null }
     window.failOpen = false
     window.open = (...args) => { if(window.failOpen) throw new Error('opener failure'); window.opened.push(args); return null }
     window.preferences = []
     if (host === "electron") window.electronAPI = { onMenuAction: handler => { window.deliverMenu = handler; return () => {} },
       openPreferences: async (...args) => { window.preferences.push(args[0]) } }
     if (host === "tauri") {
       let callback, handler
       window.__TAURI_INTERNALS__ = {
         metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
         transformCallback: fn => { callback = fn; return 1 },
         invoke: async (command, args) => {
           if (command === 'plugin:event|listen') { handler = args.handler; window.deliverMenu = payload => callback({payload}); return handler }
           if (command === 'open_external_url') { if(window.failOpen) throw new Error('opener failure'); window.opened.push([command, args]) }
           if (command === 'open_preferences_window') window.preferences.push(args.request.section)
         },
       }
     }
  `

const readOpenedUrl = (page: Page) => page.evaluate(() => {
  const opened = (window as any).opened.at(-1)
  return opened[0] === "open_external_url" ? opened[1].url : opened[0]
})

for (const [host, context] of [["web", "remote"], ["electron", "local"], ["tauri", "local"], ["electron", "remote"], ["tauri", "remote"]]) test(`${host}/${context}: native help command and palette open the live UI locale externally`, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript({ content: hostScript(host, context) })
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
     await page.getByRole("button", { name: "Palette", exact: true }).waitFor()
     await page.getByRole("textbox", { name: "Draft" }).fill("Preserved unsent draft")
    await page.evaluate(() => (window as any).helpFixture.setLocale("fr"))
     if (context === "remote") {
       await page.getByRole("button", { name: "Palette" }).click()
       await page.getByText("Ouvrir l’aide", { exact: true }).click()
     } else await page.evaluate(() => (window as any).deliverMenu("open-help"))
    await page.waitForFunction(() => (window as any).opened.length === 1)
    const readUrl = () => page.evaluate(() => {
      const opened = (window as any).opened.at(-1)
      return opened[0] === "open_external_url" ? opened[1].url : opened[0]
    })
     assert.equal(await readUrl(), "https://neuralnomadsai.github.io/CodeNomad/fr/")
     if (context === "local") {
       await page.evaluate(() => { (window as any).deliverMenu('new-instance'); (window as any).deliverMenu({invalid:'payload'}); (window as any).deliverMenu('unknown-action') })
       assert.equal(await page.evaluate(() => (window as any).newInstanceCount), 1, 'other commands keep their shared dispatch')
       assert.equal(await page.evaluate(() => (window as any).opened.length), 1, 'unknown menu payloads do nothing')
     }
    await page.evaluate(() => (window as any).helpFixture.setLocale("he"))
     await page.getByRole("button", { name: "Palette" }).click()
     await page.getByText("פתיחת עזרה", { exact: true }).click()
    await page.waitForFunction(() => (window as any).opened.length === 2)
    assert.equal(await readUrl(), "https://neuralnomadsai.github.io/CodeNomad/he/")
     assert.equal(page.url(), url, "help never replaces the renderer")
     assert.equal(await page.locator('textarea[aria-label="Draft"]').inputValue(), "Preserved unsent draft")
     assert.equal(await page.getByRole("dialog").count(), 0, "noopener null is not a failure")
     const screenshots = join(tmpdir(), "codenomad-help")
     await mkdir(screenshots, { recursive: true })
     await page.getByRole("button", { name: "Palette" }).click()
     await page.screenshot({ path: join(screenshots, `app-help-${host}-${context}-he.png`) })
     await page.evaluate(() => { (window as any).failOpen = true })
     await page.getByText("פתיחת עזרה", { exact: true }).click()
     await page.getByRole("dialog").waitFor()
     assert.ok((await page.getByRole("dialog").innerText()).includes("https://neuralnomadsai.github.io/CodeNomad/"))
     assert.equal(await page.evaluate(() => (window as any).opened.length), 2, "failed opening never replays")
     assert.equal(await page.locator('textarea[aria-label="Draft"]').inputValue(), "Preserved unsent draft")
     // About opens Settings → Info: native Preferences locally, the embedded screen remotely.
     await page.keyboard.press("Escape")
     if (context === "local") {
       await page.evaluate(() => (window as any).deliverMenu("open-about"))
       await page.waitForFunction(() => (window as any).preferences.length === 1)
       assert.deepEqual(await page.evaluate(() => (window as any).preferences), ["info"])
     } else {
       await page.getByRole("button", { name: "Palette" }).click()
       await page.getByText("אודות CodeNomad", { exact: true }).click()
       await page.waitForFunction(() => (window as any).helpFixture.settings().open)
       assert.deepEqual(await page.evaluate(() => (window as any).helpFixture.settings()), { open: true, section: "info" })
     }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [host, context] of [["web", "remote"], ["electron", "local"], ["tauri", "local"]]) test(`${host}/${context}: Support CodeNomad opens the localized sponsor page from the menu and palette`, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript({ content: hostScript(host, context) })
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Palette", exact: true }).waitFor()
    await page.evaluate(() => (window as any).helpFixture.setLocale("fr"))
    if (context === "remote") {
      await page.getByRole("button", { name: "Palette" }).click()
      await page.getByText("Soutenir CodeNomad", { exact: true }).click()
    } else await page.evaluate(() => (window as any).deliverMenu("open-sponsor"))
    await page.waitForFunction(() => (window as any).opened.length === 1)
    assert.equal(await readOpenedUrl(page), "https://neuralnomadsai.github.io/CodeNomad/fr/sponsor.html")
    await page.evaluate(() => (window as any).helpFixture.setLocale("he"))
    await page.getByRole("button", { name: "Palette" }).click()
    await page.getByText("תמכו ב־CodeNomad", { exact: true }).click()
    await page.waitForFunction(() => (window as any).opened.length === 2)
    assert.equal(await readOpenedUrl(page), "https://neuralnomadsai.github.io/CodeNomad/he/sponsor.html")
    assert.equal(page.url(), url, "the sponsor page never replaces the renderer")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => { (window as any).failOpen = true })
    await page.getByRole("button", { name: "Palette" }).click()
    await page.getByText("תמכו ב־CodeNomad", { exact: true }).click()
    await page.getByRole("dialog").waitFor()
    assert.ok((await page.getByRole("dialog").innerText()).includes("https://neuralnomadsai.github.io/CodeNomad/he/sponsor.html"))
    assert.equal(await page.evaluate(() => (window as any).opened.length), 2, "failed opening never replays")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
