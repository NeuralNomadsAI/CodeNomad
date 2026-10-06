import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { chromium, type Browser } from "playwright"

test("real bundled launcher validates before invoking and handles native failures locally", async () => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname
    if (path.includes("..")) { response.writeHead(403).end(); return }
    const file = new URL(`../../dist${path === "/" ? "/index.html" : path}`, import.meta.url)
    try {
      const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html"
      response.writeHead(200, { "Content-Type": type }).end(await readFile(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH })
    for (const locale of ["en-US", "es-ES", "fr-FR", "de-DE", "ru-RU", "ja-JP", "zh-CN", "he-IL", "ne-NP", "tr-TR"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale })
      // Literal script avoids tsx/esbuild helper references in serialized functions.
      await context.addInitScript(`
        window.calls = [];
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
          window.calls.push({ command, args });
          throw window.failure ?? "unavailable";
        }};
      `)
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.locator("form").waitFor()
      assert.equal(await page.locator("iframe").count(), 0)
      assert.equal(await page.locator("html").getAttribute("dir"), locale.startsWith("he") ? "rtl" : "ltr")
      assert.equal(await page.locator("input").getAttribute("dir"), "ltr")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.locator("input").fill("https://user:secret@example.com")
      await page.locator("button").click()
      assert.notEqual(await page.locator("#error").textContent(), "")
      assert.deepEqual(await page.evaluate(() => (window as any).calls), [])
      await page.locator("input").fill("https://EXAMPLE.com:443/")
      await page.locator("button").click()
      await page.waitForFunction(() => !(document.querySelector("button") as HTMLButtonElement).disabled)
      assert.deepEqual(await page.evaluate(() => (window as any).calls), [
        { command: "connect_server", args: { endpoint: "https://example.com/" } },
      ], JSON.stringify(await page.evaluate(() => ({ error: document.querySelector("#error")?.textContent,
        value: (document.querySelector("input") as HTMLInputElement).value,
        valid: (document.querySelector("input") as HTMLInputElement).validity.valid }))))
      await page.evaluate(() => { (window as any).failure = "unsupported" })
      await page.locator("button").click()
      await page.waitForFunction(() => !(document.querySelector("button") as HTMLButtonElement).disabled)
      assert.match((await page.locator("#error").textContent())!, /Android System WebView/)
      const output = new URL(`../../test-results/${locale}.png`, import.meta.url)
      await mkdir(new URL("../../test-results/", import.meta.url), { recursive: true })
      await page.screenshot({ path: fileURLToPath(output), fullPage: true })
      await context.close()
    }
  } finally {
    await browser?.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
