import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-preview-sandbox-fixture", configureServer(s) {
      s.middlewares.use("/session-preview-sandbox-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/session-preview-sandbox-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-preview-sandbox.tsx"></script></body></html>'))
      })
      s.middlewares.use("/previews/fixture-session-loopback", (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
        res.setHeader("Content-Type", "text/html")
        res.end('<html><body>Loopback preview fixture<script>parent.postMessage({type:"codenomad-preview-location",path:"/bridge-location"},"*")</script></body></html>')
      })
      s.middlewares.use("/previews/fixture-session-external", (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
        res.setHeader("Content-Type", "text/html")
        res.end("<html><body>External preview fixture</body></html>")
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/session-preview-sandbox-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const sandboxTokens = async (page: Page, selector: string): Promise<string[]> =>
  (await page.locator(`${selector} iframe`).evaluate((frame) =>
    (frame.getAttribute("sandbox") ?? "").split(" ").filter(Boolean))) as string[]

const allowTokens = async (page: Page, selector: string): Promise<string[]> =>
  (await page.locator(`${selector} iframe`).evaluate((frame) =>
    (frame.getAttribute("allow") ?? "").split(";").map((value) => value.trim()).filter(Boolean))) as string[]

const frameSource = async (page: Page, selector: string): Promise<string> =>
  (await page.locator(`${selector} iframe`).getAttribute("src")) ?? ""

async function openFixture(page: Page, query = ""): Promise<void> {
  await page.goto(`${url}${query}`)
  await page.locator("#fixture-status[data-config-loaded='true']").waitFor({ state: "attached" })
  await page.locator("#loopback-preview-root iframe").waitFor({ state: "attached" })
  await page.locator("#external-preview-root iframe").waitFor({ state: "attached" })
}

test("the default opaque policy keeps both preview frames out of the web origin", async () => {
  const page = await browser.newPage()
  try {
    await openFixture(page)

    const loopbackSandbox = new Set(await sandboxTokens(page, "#loopback-preview-root"))
    assert.equal(loopbackSandbox.has("allow-same-origin"), false)
    assert.equal(loopbackSandbox.has("allow-scripts"), true)

    const externalSandbox = new Set(await sandboxTokens(page, "#external-preview-root"))
    assert.equal(externalSandbox.has("allow-same-origin"), false)
    assert.equal(externalSandbox.has("allow-scripts"), true)

    assert.equal(await frameSource(page, "#loopback-preview-root"), "/previews/fixture-session-loopback/")
    assert.equal(await frameSource(page, "#external-preview-root"), "/previews/fixture-session-external/")
  } finally {
    await page.close()
  }
})

test("app mode trusts only the loopback preview frame", async () => {
  const page = await browser.newPage()
  try {
    await openFixture(page, "?mode=app")
    await page.waitForFunction(() => {
      const frame = document.querySelector("#loopback-preview-root iframe")
      return (frame?.getAttribute("sandbox") ?? "").split(" ").includes("allow-same-origin")
    })

    const loopbackSandbox = new Set(await sandboxTokens(page, "#loopback-preview-root"))
    assert.equal(loopbackSandbox.has("allow-same-origin"), true)

    const externalSandbox = new Set(await sandboxTokens(page, "#external-preview-root"))
    assert.equal(externalSandbox.has("allow-same-origin"), false)

    assert.equal(await frameSource(page, "#loopback-preview-root"), "/previews/fixture-session-loopback/")
  } finally {
    await page.close()
  }
})

test("custom mode serves previews from the configured origin", async () => {
  const page = await browser.newPage()
  try {
    await openFixture(page, "?mode=custom")
    await page.waitForFunction(() =>
      (document.querySelector("#loopback-preview-root iframe")?.getAttribute("src") ?? "").startsWith("https://preview.example.test"))

    assert.equal(
      await frameSource(page, "#loopback-preview-root"),
      "https://preview.example.test/previews/fixture-session-loopback/",
    )
    assert.equal(
      await frameSource(page, "#external-preview-root"),
      "https://preview.example.test/previews/fixture-session-external/",
    )
  } finally {
    await page.close()
  }
})

test("the configured sandbox and feature policy reach the preview iframe", async () => {
  const page = await browser.newPage()
  try {
    await openFixture(page, "?mode=app&forms=off&camera=on")
    await page.waitForFunction(() => {
      const frame = document.querySelector("#loopback-preview-root iframe")
      const sandbox = (frame?.getAttribute("sandbox") ?? "").split(" ")
      const allow = (frame?.getAttribute("allow") ?? "").split(";").map((value) => value.trim())
      return !sandbox.includes("allow-forms") && allow.includes("camera")
    })

    const sandbox = new Set(await sandboxTokens(page, "#loopback-preview-root"))
    assert.equal(sandbox.has("allow-forms"), false)
    assert.equal(sandbox.has("allow-scripts"), true)
    assert.equal(sandbox.has("allow-modals"), true)
    assert.equal(sandbox.has("allow-same-origin"), true)

    const allow = await allowTokens(page, "#loopback-preview-root")
    assert.equal(allow.includes("camera"), true)
    assert.equal(allow.includes("camera 'none'"), false)
    assert.equal(allow.includes("clipboard-read 'none'"), true)
    assert.equal(allow.includes("clipboard-write 'none'"), true)
    assert.equal(allow.includes("microphone 'none'"), true)
  } finally {
    await page.close()
  }
})

test("the location bridge accepts the expected origin and ignores foreign ones", async () => {
  const page = await browser.newPage()
  try {
    await openFixture(page, "?mode=app")
    await page.waitForFunction(() =>
      document.querySelector("#received-locations")?.getAttribute("data-loopback") === "http://localhost:3000/bridge-location")

    // A message claiming another origin from the trusted frame is not the app origin.
    await page.evaluate(() => {
      const frame = document.querySelector("#loopback-preview-root iframe") as HTMLIFrameElement
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "codenomad-preview-location", path: "/forged-loopback" },
        origin: "https://example.com",
        source: frame.contentWindow,
      }))
    })
    assert.equal(
      await page.locator("#received-locations").getAttribute("data-loopback"),
      "http://localhost:3000/bridge-location",
    )

    // The external frame is opaque, so a message claiming the app origin is not expected.
    await page.evaluate(() => {
      const frame = document.querySelector("#external-preview-root iframe") as HTMLIFrameElement
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "codenomad-preview-location", path: "/forged-external" },
        origin: location.origin,
        source: frame.contentWindow,
      }))
    })
    assert.equal(
      await page.locator("#received-locations").getAttribute("data-external"),
      "https://example.com/",
    )
  } finally {
    await page.close()
  }
})
