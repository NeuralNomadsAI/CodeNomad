import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { createServer as createHttpServer } from "node:http"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { build } from "vite"
import { chromium } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("built generateSW caches only UI assets and updates the same registration", { timeout: 120000 }, async () => {
  const ui = fileURLToPath(new URL("../../", import.meta.url))
  const output = await mkdtemp(path.join(os.tmpdir(), "codenomad-push-pwa-"))
  let update = false
  let server: http.Server | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await build({ configFile: path.join(ui, "vite.config.ts"), root: path.join(ui, "src/renderer"),
      logLevel: "silent", build: { outDir: output, sourcemap: false } })
    server = createHttpServer(async (req, res) => {
      const pathname = new URL(req.url!, "http://fixture").pathname
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html")
        res.end("<!doctype html><title>Built worker fixture</title>")
        return
      }
      const file = path.resolve(output, `.${pathname}`)
      if (file.startsWith(output + path.sep)) {
        try {
          const bytes = await readFile(file)
          res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream")
          res.end(pathname === "/sw.js" && update ? Buffer.concat([bytes, Buffer.from("\n/* update fixture */")]) : bytes)
          return
        } catch { /* Private sentinels are deliberately absent from the built asset tree. */ }
      }
      res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : "image/svg+xml")
      res.setHeader("Cache-Control", "private, no-store")
      res.end(pathname.endsWith(".js") ? "/* authenticated sentinel */" : '<svg xmlns="http://www.w3.org/2000/svg"/>')
    })
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
    browser = await chromium.launch()
    armFixtureNavigationBudget(browser)
    const page = await browser.newPage()
    await page.goto(origin)
    await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready })
    await page.reload()
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    const privatePaths = ["/api/private.js", "/workspaces/private.js", "/connections/private.js",
      "/media/private.svg", "/previews/private.js", "/authenticated/private.svg"]
    await page.evaluate(async paths => {
      await Promise.all(paths.map(src => new Promise<void>(resolve => {
        const el = document.createElement(src.endsWith(".js") ? "script" : "img")
        el.onload = el.onerror = () => resolve()
        ;(el as HTMLImageElement).src = src
        document.body.append(el)
      })))
    }, privatePaths)
    const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat())
    assert(keys.length > 100, "real generated precache populated")
    assert(!keys.includes("/"), "authenticated UI document stays on the network")
    assert(privatePaths.every(path => !keys.includes(path)))
    assert(keys.every(path => !path.startsWith("/api/") && !path.startsWith("/workspaces/") && !path.endsWith(".html")))
    const registrationsBefore = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.scope))
    update = true
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      const changed = new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }))
      await reg.update()
      await changed
    })
    assert.deepEqual(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.scope)), registrationsBefore)
    assert.equal(await page.evaluate(async () => (await caches.keys()).includes("asset-cache")), false)
  } finally {
    await browser?.close()
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    await rm(output, { recursive: true, force: true })
  }
})
