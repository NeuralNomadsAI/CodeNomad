import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "device-upload-fixture", configureServer(s) {
      s.middlewares.use("/device-upload-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/device-upload-fixture", '<html><body><div id="root" style="display:flex;height:700px;width:1000px"></div><script type="module" src="/tests/browser/fixtures/device-upload.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/device-upload-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(host = "web", context = "remote") {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const prompts: any[] = [], paths: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(({ host, context }) => {
    ;(window as any).__CODENOMAD_RUNTIME_HOST__ = host
    ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = context
  }, { host, context })
  await page.route("**/api/**", route => {
    const request = route.request(), target = new URL(request.url())
    if (target.pathname.endsWith("/prompt")) {
      prompts.push(request.postDataJSON())
      return route.fulfill({ json: { data: {} } })
    }
    if (target.pathname.startsWith("/api/filesystem")) {
      paths.push(request.url())
      return route.fulfill({ json: target.pathname.endsWith("/content")
        ? { contents: Buffer.from("SERVER_CONTENT").toString("base64"), encoding: "base64" }
        : { entries: [{ name: "server.txt", path: "/remote/workspace/server.txt", absolutePath: "/remote/workspace/server.txt", type: "file", size: 14 }],
          metadata: { rootPath: "/remote/workspace", currentPath: "/remote/workspace", displayPath: "/remote/workspace", pathKind: "absolute" } } })
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, prompts, paths, errors }
}

async function chooseDevice(page: Page) {
  await page.locator(".prompt-actions-menu-trigger").click()
  assert.equal(await page.getByRole("menuitem", { name: "Attach files", exact: true }).count(), 1)
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Upload from device", exact: true }).click()
  return chooser
}

for (const [host, context] of [["web", "remote"], ["tauri", "local"], ["tauri", "remote"], ["electron", "local"], ["electron", "remote"]]) {
  test(`${host}/${context}: device files use native selection and arrive as bytes in the prompt`, async () => {
    const { page, prompts, paths, errors } = await setup(host, context)
    try {
      const chooser = await chooseDevice(page)
      assert.equal(chooser.isMultiple(), true)
      await chooser.setFiles([])
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
      const files = [
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Café depuis mon appareil\nSecond line") },
        { name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=", "base64") },
        { name: "document.pdf", mimeType: "", buffer: Buffer.from("%PDF-1.4\nfixture") },
      ]
      await (await chooseDevice(page)).setFiles(files)
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 3)
      await page.getByRole("button", { name: "Send message", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
      assert.equal(prompts.length, 1)
      assert.deepEqual(prompts[0].files.sort((a: any, b: any) => a.name.localeCompare(b.name)), files.map(file => ({
        name: file.name, uri: `data:${file.mimeType || "application/pdf"};base64,${file.buffer.toString("base64")}`,
      })).sort((a, b) => a.name.localeCompare(b.name)))
      assert.deepEqual(paths, [])
      // Resetting the input permits selecting the same file again.
      await (await chooseDevice(page)).setFiles(files[0])
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("server-side browsing remains available alongside device upload", async () => {
  const { page, paths, prompts, errors } = await setup("tauri", "local")
  try {
    await page.locator(".prompt-actions-menu-trigger").click()
    if (process.env.CODENOMAD_UPLOAD_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_UPLOAD_CAPTURE })
    await page.getByRole("menuitem", { name: "Attach files", exact: true }).click()
    await page.getByRole("dialog").getByText("server.txt", { exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.equal(paths.length, 2)
    assert.deepEqual(prompts[0].files, [{ name: "server.txt", uri: `data:text/plain;base64,${Buffer.from("SERVER_CONTENT").toString("base64")}` }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("device uploads reject oversized files even when a desktop path is exposed", async () => {
  const { page, paths } = await setup("electron", "remote")
  try {
    await page.evaluate(() => Object.defineProperty(File.prototype, "path", { value: "C:\\private\\local.bin" }))
    await (await chooseDevice(page)).setFiles([
      { name: "large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
      { name: "another.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ])
    await page.getByText("2 selected files could not be attached because they are larger than the 5 MB attachment limit.", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.deepEqual(paths, [])
  } finally { await page.close() }
})

test("pending file reads block sending and do not leak into another session", async () => {
  const { page, prompts } = await setup()
  try {
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer
      FileReader.prototype.readAsArrayBuffer = function (file) {
        this.addEventListener("loadend", () => { (window as any).readFinished = true })
        ;(window as any).releaseRead = () => read.call(this, file)
      }
    })
    await page.locator("textarea:visible").first().fill("Keep this prompt")
    await (await chooseDevice(page)).setFiles({ name: "delayed.txt", mimeType: "text/plain", buffer: Buffer.from("late data") })
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true)
    await page.locator("textarea:visible").first().press("Enter")
    assert.equal(prompts.length, 0)
    await page.evaluate(() => (window as any).fixture.switch("other"))
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "")
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).readFinished)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments("other")), [])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments("source")), [])
  } finally { await page.close() }
})

test("a failed device read reports the failure instead of attaching a local path", async () => {
  const { page } = await setup("electron", "remote")
  try {
    await page.evaluate(() => {
      Object.defineProperty(File.prototype, "path", { value: "C:\\private\\unreadable.txt" })
      FileReader.prototype.readAsArrayBuffer = function () {
        this.dispatchEvent(new ProgressEvent("error"))
        this.dispatchEvent(new ProgressEvent("loadend"))
      }
    })
    await (await chooseDevice(page)).setFiles({ name: "unreadable.txt", mimeType: "text/plain", buffer: Buffer.from("data") })
    await page.getByText("Some files were not attached", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    await page.locator("textarea:visible").first().fill("Continue without attachment")
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(), true)
  } finally { await page.close() }
})
