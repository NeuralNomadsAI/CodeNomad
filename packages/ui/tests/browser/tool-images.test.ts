import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "tool-images-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/tool-images.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Image fixture failure", errors, await page.locator("main").innerText(),
      await page.locator(".tool-call-output-images").evaluateAll(elements => elements.map(el => el.outerHTML.slice(0, 1500))))
    throw error
  } finally { await page.close() }
}

async function decodedImages(page: Page, count: number) {
  await page.waitForFunction(count => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".tool-call-output-images img"))
    return images.length === count && images.every(img => img.complete && img.naturalWidth === 800)
  }, count)
  assert.equal((await page.locator("main").innerText()).includes("base64"), false)
}

test("MCP images render with text on native live completion and historical reload", async () => withPage(async page => {
  await page.evaluate(() => (window as any).fixture.start())
  assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
  await page.evaluate(() => (window as any).fixture.finish())
  await decodedImages(page, 2)
  await page.getByText("Generated 2 images. Saved successfully.", { exact: true }).waitFor()
  assert.equal(await page.getByRole("img", { name: "generated.png", exact: true }).count(), 1)
  assert.equal(await page.getByRole("img", { name: "Image 2", exact: true }).count(), 1)
  await page.evaluate(() => (window as any).fixture.reload())
  await decodedImages(page, 2)
  await page.setViewportSize({ width: 380, height: 1000 })
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
  if (process.env.CODENOMAD_IMAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_IMAGE_CAPTURE, fullPage: true })
}))

test("image-only output works for generic and specialized tools and obeys collapse", async () => withPage(async page => {
  for (const name of ["forge-painter_txt2img", "read"]) {
    await page.evaluate(name => (window as any).fixture.history("only", name), name)
    await decodedImages(page, 1)
    const header = page.locator(".tool-call-header").first()
    await header.click()
    assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
    await header.click()
    await decodedImages(page, 1)
  }
  await page.evaluate(() => (window as any).fixture.history("empty"))
  await page.getByText("Text-only result", { exact: true }).waitFor()
  assert.equal(await page.locator(".tool-call-output-images").count(), 0)
}))

test("failed and unsupported image sources have a fallback and a later replacement recovers", async () => withPage(async page => {
  for (const kind of ["broken", "unsafe"]) {
    await page.evaluate(kind => (window as any).fixture.history(kind), kind)
    await page.getByText("Unable to display this image.", { exact: true }).waitFor()
    assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
    assert.equal((await page.locator("main").innerText()).includes("base64"), false)
    await page.evaluate(() => (window as any).fixture.history("only"))
    await decodedImages(page, 1)
  }
  assert.equal(await page.evaluate(() => (window as any).unexpectedNavigation), undefined)
}))
