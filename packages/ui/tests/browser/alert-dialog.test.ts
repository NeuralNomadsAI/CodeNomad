import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: "node_modules/.vite-alert-dialog", resolve: { dedupe: ["solid-js"] },
    plugins: [solid(), { name: "alert-dialog-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/alert-dialog.tsx"></script></body></html>'))
      })
    } }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

/** Waits until exactly `label` is focused and is the only button painted with the primary accent. */
async function expectAccentOn(page: Page, label: string) {
  await page.waitForFunction(expected => {
    const probe = document.createElement("div")
    probe.style.backgroundColor = "var(--button-primary-bg)"
    document.body.append(probe)
    const primary = getComputedStyle(probe).backgroundColor
    probe.remove()
    const accented = [...document.querySelectorAll('[role="dialog"] button')]
      .filter(button => getComputedStyle(button).backgroundColor === primary)
      .map(button => button.textContent?.trim())
    return document.activeElement?.textContent?.trim() === expected && accented.length === 1 && accented[0] === expected
  }, label)
}

async function openConfirm(page: Page) {
  await page.evaluate(() => (window as any).fixture.confirm())
  await page.getByRole("dialog").waitFor()
  // Let any late focus move settle before checking it.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function result(page: Page) {
  await page.waitForFunction(() => (window as any).confirmResult !== undefined)
  return page.evaluate(() => (window as any).confirmResult)
}

test("the confirmation accent follows focus: Cancel by default, Enter and Escape cancel, Tab then Enter confirms", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByRole("button", { name: "Delete session" }).click()

    // The accent marks what Enter does; Cancel is the focused default.
    await openConfirm(page)
    await expectAccentOn(page, "Keep")
    await page.keyboard.press("Enter")
    assert.equal(await result(page), false)

    await openConfirm(page)
    await expectAccentOn(page, "Keep")
    await page.keyboard.press("Escape")
    assert.equal(await result(page), false)

    // Deleting from the keyboard stays one deliberate step away, and the accent moves with it.
    await openConfirm(page)
    await page.keyboard.press("Tab")
    await expectAccentOn(page, "Delete")
    await page.keyboard.press("Enter")
    assert.equal(await result(page), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
