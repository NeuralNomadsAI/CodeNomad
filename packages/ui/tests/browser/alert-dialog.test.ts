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

type Paint = { focused: string, filled: string[], ring: string[] }

/**
 * Waits until the focused control (button label or "input"), the dialog buttons filled with the primary
 * background and those showing the focus ring match `expected`, letting focus moves and transitions settle.
 */
async function expectPaint(page: Page, expected: Paint) {
  const settled = await page.waitForFunction(expected => {
    const probe = document.body.appendChild(document.createElement("div"))
    probe.style.backgroundColor = "var(--button-primary-bg)"
    const primary = getComputedStyle(probe).backgroundColor
    probe.remove()
    const buttons = [...document.querySelectorAll('[role="dialog"] button')].map(button => {
      const style = getComputedStyle(button)
      return { label: button.textContent?.trim() ?? "", filled: style.backgroundColor === primary, ring: style.outlineStyle !== "none" && style.outlineWidth !== "0px" && style.boxShadow !== "none" }
    })
    const active = document.activeElement
    const paint: Paint = {
      focused: active?.tagName === "INPUT" ? "input" : active?.textContent?.trim() ?? "",
      filled: buttons.filter(button => button.filled).map(button => button.label),
      ring: buttons.filter(button => button.ring).map(button => button.label),
    }
    ;(window as any).lastPaint = paint
    return JSON.stringify(paint) === JSON.stringify(expected)
  }, expected, { timeout: 5000 }).then(() => true, () => false)
  if (!settled) assert.deepEqual(await page.evaluate(() => (window as any).lastPaint as Paint), expected)
}

/** Opens a dialog right after a mouse click, where :focus-visible would hide the initial focus. */
async function open(page: Page, kind: "confirm" | "prompt" | "choice" | "alert") {
  await page.getByRole("button", { name: "Delete session" }).click()
  await page.evaluate(kind => (window as any).fixture[kind](), kind)
  await page.getByRole("dialog").waitFor()
  // Let any late focus move settle before checking it.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function result(page: Page) {
  await page.waitForFunction(() => (window as any).confirmResult !== undefined)
  return page.evaluate(() => (window as any).confirmResult)
}

test("alert dialogs show the focus ring on the button Enter acts on, from the initial focus", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))

    // Confirm stays the filled primary action, but focus and its ring start on Cancel: Enter cancels.
    await open(page, "confirm")
    await expectPaint(page, { focused: "Keep", filled: ["Delete"], ring: ["Keep"] })
    await page.keyboard.press("Enter")
    assert.equal(await result(page), false)

    await open(page, "confirm")
    await expectPaint(page, { focused: "Keep", filled: ["Delete"], ring: ["Keep"] })
    await page.keyboard.press("Escape")
    assert.equal(await result(page), false)

    // Deleting from the keyboard stays one deliberate step away, and the ring moves with focus.
    await open(page, "confirm")
    await page.keyboard.press("Tab")
    await expectPaint(page, { focused: "Delete", filled: ["Delete"], ring: ["Delete"] })
    await page.keyboard.press("Enter")
    assert.equal(await result(page), true)

    // Prompts focus their input, where Enter submits; choices ring their last, non-destructive choice.
    await open(page, "prompt")
    await expectPaint(page, { focused: "input", filled: ["Rename"], ring: [] })
    await page.keyboard.press("Escape")
    assert.equal(await result(page), null)

    await open(page, "choice")
    await expectPaint(page, { focused: "Save", filled: ["Save"], ring: ["Save"] })
    await page.keyboard.press("Shift+Tab")
    await expectPaint(page, { focused: "Discard", filled: ["Save"], ring: ["Discard"] })
    await page.keyboard.press("Escape")
    assert.equal(await result(page), null)


    // Alerts focus their single OK.
    await open(page, "alert")
    await expectPaint(page, { focused: "OK", filled: ["OK"], ring: ["OK"] })
    await page.keyboard.press("Enter")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
