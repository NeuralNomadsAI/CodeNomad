import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "aside-fixture", configureServer(s) {
      s.middlewares.use("/aside-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/aside-fixture", '<html><body><div id="root" style="margin:24px;max-width:1100px"></div><script type="module" src="/tests/browser/fixtures/session-aside.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/aside-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(respond?: (route: Route) => Promise<void>, width = 1200) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, locale: "en-US" })
  const requests: { url: string; body: any }[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (text) => {window.copiedText = text}}})`)
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/generate")) {
      requests.push({ url: request.url(), body: request.postDataJSON() })
      return respond ? respond(route) : route.fulfill({ json: { data: { text: "## Side answer\n\n**Only in this window.**" } } })
    }
    if (request.url().endsWith("/api/command")) return route.fulfill({ json: { data: [{ name: "btw", description: "Server collision" }, { name: "review", description: "Review code" }] } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, requests, errors }
}
const composer = (page: Page) => page.locator(".prompt-input-container textarea").first()
async function send(page: Page, text: string) {
  await composer(page).fill(text)
  // Clicking Send also covers routing while the slash picker is still open.
  await page.locator(".send-button").click()
}

test("/btw is discoverable, uses native generation, renders Markdown and leaves the conversation untouched", async () => {
  const { page, requests, errors } = await setup()
  try {
    await composer(page).fill("/btw")
    await page.getByText("Ask a side question without adding to the conversation", { exact: true }).waitFor()
    assert.equal(await page.getByText("Server collision", { exact: true }).count(), 0)
    await send(page, "/btw\nWhy this approach?")
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("heading", { name: "Side answer", exact: true }).waitFor({ timeout: 10000 }).catch(async cause => {
      throw new Error(JSON.stringify({ requests, errors, body: await page.locator("body").innerText(), cause: String(cause) }))
    })
    assert.equal(requests.length, 1)
    assert.ok(requests[0].url.endsWith("/api/session/source/generate"))
    assert.ok(requests[0].body.prompt.endsWith("\n\nWhy this approach?"))
    assert.match(requests[0].body.prompt, /Do not call any tools/)
    assert.deepEqual(Object.keys(requests[0].body), ["prompt"])
    await dialog.getByRole("button", { name: "Copy answer", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).copiedText), "## Side answer\n\n**Only in this window.**")
    await page.locator("#outside").click()
    assert.equal(await dialog.isVisible(), true)
    const snapshot = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(snapshot.sends, [])
    assert.deepEqual(snapshot.commands, [])
    assert.equal(snapshot.interrupts, 0)
    if (process.env.CODENOMAD_ASIDE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_ASIDE_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("bare /btw opens a question form; attachments and normal command routing survive", async () => {
  const { page, requests } = await setup()
  try {
    await page.evaluate(() => (window as any).fixture.attach())
    await send(page, "/btw")
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    assert.equal(requests.length, 0)
    assert.equal(await dialog.getByRole("button", { name: "Ask", exact: true }).isDisabled(), true)
    await dialog.getByLabel("Your question", { exact: true }).fill("What happened?")
    await dialog.getByRole("button", { name: "Ask", exact: true }).click()
    await dialog.getByRole("heading", { name: "Side answer" }).waitFor()
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).attachments, 1)
    await dialog.getByRole("button", { name: "Close side question" }).click()
    await composer(page).fill("/btw [Pasted #1] [Image #1]")
    await page.evaluate(() => { (window as any).fixture.paste(); (window as any).fixture.image() })
    await page.locator(".send-button").click()
    await page.getByRole("heading", { name: "Side answer" }).waitFor()
    assert.ok(requests[1].body.prompt.includes("PASTED_QUESTION"))
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).attachments, 2)
    assert.equal(await composer(page).inputValue(), "[Image #1]")
    await page.getByRole("button", { name: "Close side question" }).click()
    await send(page, "/review module")
    await send(page, "/btwExtra is normal text")
    const snapshot = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(snapshot.commands, [{ name: "review", text: "module" }])
    assert.equal(snapshot.sends[0].text, "/btwExtra is normal text")
    assert.equal(requests.length, 2)
  } finally { await page.close() }
})

test("pending side questions do not block normal prompts; a second side question keeps its draft", async () => {
  let release!: () => Promise<void>
  const { page, requests } = await setup(route => new Promise<void>(resolve => {
    release = async () => { await route.fulfill({ json: { data: { text: "Delayed answer" } } }); resolve() }
  }))
  try {
    await send(page, "/btw First question")
    await page.getByRole("status").filter({ hasText: "Thinking" }).waitFor()
    await send(page, "/btw Second question")
    assert.equal(await composer(page).inputValue(), "/btw Second question")
    assert.equal(requests.length, 1)
    await send(page, "Continue the main task")
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).sends.length, 1)
    await release()
    await page.getByText("Delayed answer", { exact: true }).waitFor()
  } finally { await page.close() }
})

for (const exit of ["close", "cancel", "switch", "inactive", "unmount"] as const) {
  test(`${exit} fences pending results without interrupting the main session`, async () => {
    const { page } = await setup()
    try {
      // A deliberately non-cooperative transport resolves even after abort.
      // This exercises the result fence, not just the browser's fetch cancellation.
      await page.evaluate(async () => {
        const { getRootClient } = await import("/src/stores/opencode-client.ts")
        getRootClient("aside-instance").session.generate = (_input: any, options: any) => new Promise(resolve => {
          ;(window as any).asideSignal = options.signal
          ;(window as any).resolveAside = resolve
        })
      })
      await send(page, "/btw delayed")
      await page.getByRole("status").filter({ hasText: "Thinking" }).waitFor()
      if (exit === "close") await page.keyboard.press("Escape")
      if (exit === "cancel") await page.getByRole("button", { name: "Cancel question" }).click()
      if (exit === "switch") await page.evaluate(() => (window as any).fixture.switch("other"))
      if (exit === "inactive") await page.evaluate(() => (window as any).fixture.active(false))
      if (exit === "unmount") await page.evaluate(() => (window as any).fixture.unmount())
      await page.waitForFunction(() => (window as any).asideSignal.aborted)
      await page.evaluate(() => (window as any).resolveAside({ text: "STALE_RESPONSE" }))
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await page.getByText("STALE_RESPONSE", { exact: true }).count(), 0)
      assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).interrupts, 0)
      assert.equal(await page.getByRole("dialog").count(), exit === "cancel" ? 1 : 0)
    } finally { await page.close() }
  })
}

test("a cancelled request cannot overwrite or settle a newer side question", async () => {
  const { page } = await setup()
  try {
    await page.evaluate(async () => {
      const { getRootClient } = await import("/src/stores/opencode-client.ts")
      ;(window as any).asideResolvers = []
      getRootClient("aside-instance").session.generate = () => new Promise(resolve => (window as any).asideResolvers.push(resolve))
    })
    await send(page, "/btw Old question")
    await page.getByRole("button", { name: "Cancel question" }).click()
    await page.getByLabel("Your question").fill("New question")
    await page.getByLabel("Your question").press("Control+Enter")
    await page.waitForFunction(() => (window as any).asideResolvers.length === 2)
    await page.evaluate(() => (window as any).asideResolvers[0]({ text: "STALE_RESPONSE" }))
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.getByRole("button", { name: "Cancel question" }).isVisible(), true)
    assert.equal(await page.getByText("STALE_RESPONSE", { exact: true }).count(), 0)
    await page.evaluate(() => (window as any).asideResolvers[1]({ text: "NEW_RESPONSE" }))
    await page.getByText("NEW_RESPONSE", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("errors and empty answers remain retryable; the window fits a narrow screen", async () => {
  let calls = 0
  const { page } = await setup(route => {
    calls++
    return calls === 1 ? route.fulfill({ status: 503, json: { message: "Provider unavailable" } })
      : route.fulfill({ json: { data: { text: calls === 2 ? "   " : "Recovered answer" } } })
  }, 360)
  try {
    await send(page, "/btw Try this question")
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("alert").waitFor()
    assert.equal(await dialog.getByLabel("Your question").inputValue(), "Try this question")
    await dialog.getByRole("button", { name: "Ask", exact: true }).click()
    await dialog.getByText(/The model returned no text/).waitFor()
    await dialog.getByRole("button", { name: "Ask", exact: true }).click()
    await dialog.getByText("Recovered answer", { exact: true }).waitFor()
    const bounds = await dialog.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.height < 850)
  } finally { await page.close() }
})
