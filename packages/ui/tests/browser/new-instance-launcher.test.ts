import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "new-instance-launcher-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/new-instance-launcher.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(width = 1100) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).launcherFixture))
  return { page, errors, calls: () => page.evaluate(() => [...(window as any).launcherFixture.calls]) }
}
const plus = (page: Page) => page.locator(".new-instance-button")
const launcher = (page: Page) => page.locator(".new-instance-launcher")
const options = (page: Page) => launcher(page).getByRole("option")
// The popup focuses its search field on the next frame; type once it has focus.
const openedWithFocus = async (page: Page) => {
  await launcher(page).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox")
}

test("a click keeps the full home page while a long press opens the launcher", async () => {
  const { page, errors, calls } = await prepare()
  try {
    await plus(page).click()
    assert.deepEqual(await calls(), ["home"])
    assert.equal(await launcher(page).count(), 0)
    assert.match((await plus(page).getAttribute("title")) ?? "", /long press or right-click/)

    const box = (await plus(page).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await launcher(page).waitFor()
    await page.mouse.up()
    // The release that ends a long press is not a second, home-page click.
    assert.deepEqual(await calls(), ["home"])
    assert.equal(await plus(page).getAttribute("aria-expanded"), "true")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 15)
    assert.equal(await options(page).first().getAttribute("aria-selected"), "true")
    assert.match(await options(page).first().innerText(), /CodeNomad[\s\S]*open/)
    assert.match(await options(page).nth(2).innerText(), /Blender tools/)
    if (process.env.CODENOMAD_LAUNCHER_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("typing filters recent projects and the keyboard opens or switches to them", async () => {
  const { page, errors, calls } = await prepare()
  try {
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    await page.keyboard.type("blend")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 1)
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(await calls(), ["folder:D:/blender"])

    await plus(page).focus()
    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await page.keyboard.type("zzz")
    await launcher(page).getByText("No project matches.").waitFor()
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    // An already open project switches to its tab instead of opening a duplicate.
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual((await calls()).at(-1), "existing:codenomad-tab:D:/CodeNomad")

    await plus(page).click({ button: "right" })
    await launcher(page).waitFor()
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("creation and secondary actions close the launcher before running", async () => {
  const { page, errors, calls } = await prepare(390)
  try {
    for (const [name, call] of [["Temporary", "temporary"], ["SideCar", "sidecar"], ["Full home page", "full-home"]] as const) {
      await plus(page).click({ button: "right" })
      await launcher(page).waitFor()
      const width = await launcher(page).evaluate(el => el.getBoundingClientRect().width)
      assert.ok(width <= 390, `launcher fits a narrow window (${width}px)`)
      await launcher(page).getByRole("button", { name, exact: true }).click()
      await launcher(page).waitFor({ state: "detached" })
      assert.equal((await calls()).at(-1), call)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
