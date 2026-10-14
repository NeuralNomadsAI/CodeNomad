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

type Paint = { focused: string, accent: string[], hoverAccent: string[] }

/**
 * Waits until the focused control (button label or "input") and the dialog buttons painted with the
 * primary accent, at rest or hovered, match `expected`, letting focus moves and transitions settle.
 */
async function expectPaint(page: Page, expected: Partial<Paint>) {
  const settled = await page.waitForFunction(expected => {
    const probe = document.body.appendChild(document.createElement("div"))
    const colors: Record<string, string> = {}
    for (const token of ["--button-primary-bg", "--button-primary-hover-bg"]) {
      probe.style.backgroundColor = `var(${token})`
      colors[token] = getComputedStyle(probe).backgroundColor
    }
    probe.remove()
    const buttons = [...document.querySelectorAll('[role="dialog"] button')]
      .map(button => ({ label: button.textContent?.trim() ?? "", color: getComputedStyle(button).backgroundColor }))
    const active = document.activeElement
    const paint: Paint = {
      focused: active?.tagName === "INPUT" ? "input" : active?.textContent?.trim() ?? "",
      accent: buttons.filter(button => button.color === colors["--button-primary-bg"]).map(button => button.label),
      hoverAccent: buttons.filter(button => button.color === colors["--button-primary-hover-bg"]).map(button => button.label),
    }
    ;(window as any).lastPaint = paint
    return Object.entries(expected).every(([key, value]) => JSON.stringify(paint[key as keyof Paint]) === JSON.stringify(value))
  }, expected, { timeout: 5000 }).then(() => true, () => false)
  if (!settled) {
    const actual = await page.evaluate(() => (window as any).lastPaint as Paint)
    assert.deepEqual(actual, { ...actual, ...expected })
  }
}

const expectAccentOn = (page: Page, label: string) => expectPaint(page, { focused: label, accent: [label] })

async function open(page: Page, kind: "confirm" | "prompt" | "alert") {
  await page.evaluate(kind => (window as any).fixture[kind](), kind)
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
    await open(page, "confirm")
    await expectAccentOn(page, "Keep")
    await page.keyboard.press("Enter")
    assert.equal(await result(page), false)

    // Hover darkens the focused accent; hovering the other button does not accent it.
    await open(page, "confirm")
    await expectAccentOn(page, "Keep")
    await page.getByRole("button", { name: "Keep", exact: true }).hover()
    await expectPaint(page, { focused: "Keep", accent: [], hoverAccent: ["Keep"] })
    await page.getByRole("button", { name: "Delete", exact: true }).hover()
    await expectPaint(page, { focused: "Keep", accent: ["Keep"], hoverAccent: [] })
    await page.mouse.move(0, 0)
    await page.keyboard.press("Escape")
    assert.equal(await result(page), false)

    // Deleting from the keyboard stays one deliberate step away, and the accent moves with it.
    await open(page, "confirm")
    await page.keyboard.press("Tab")
    await expectAccentOn(page, "Delete")
    await page.keyboard.press("Enter")
    assert.equal(await result(page), true)

    // Prompts keep the submit accent while their input owns focus; alerts focus their accented OK.
    await open(page, "prompt")
    await expectPaint(page, { focused: "input", accent: ["Rename"] })
    await page.keyboard.press("Escape")
    assert.equal(await result(page), null)

    await open(page, "alert")
    await expectAccentOn(page, "OK")
    await page.keyboard.press("Enter")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
