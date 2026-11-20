import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { privatePath } from "./isolation.mjs"
import { now } from "./lib.mjs"
import { withBackend } from "./stacks.mjs"

export async function withBrowser(daemon, tree, root, run) {
  return withBackend(daemon, tree, root, async (url, cookie) => {
    const profile = privatePath(path.join(root, "chromium"))
    // Chromium puts its Linux singleton socket under TMPDIR; keep it short.
    const socketDir = process.platform === "linux" ? await mkdtemp(path.join(os.tmpdir(), "cn-perf-")) : undefined
    let context
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: true, channel: "chromium", env: { ...daemon.env, ...(socketDir && { TMPDIR: socketDir }) },
        viewport: { width: 1440, height: 1440 }, locale: "en-US", serviceWorkers: "block",
      })
      await context.addInitScript({ path: fileURLToPath(new URL("./page-probe.js", import.meta.url)) })
      await context.addCookies([{ name: "codenomad_session", value: cookie, url }])
      const page = context.pages()[0] ?? await context.newPage()
      page.setDefaultTimeout(60_000)
      const failures = []
      page.on("pageerror", error => failures.push(error.message))
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.locator(".folder-home-recent-primary-action").first().click()
      const search = page.getByRole("button", { name: "Search sessions" })
      await search.click()
      await page.getByPlaceholder(/Search sessions/i).fill("Foreground")
      await page.getByText("Foreground history", { exact: true }).first().click()
      await search.click()
      await page.getByText(/SEED\d+ history turn/).first().waitFor()
      const composer = page.getByPlaceholder(/type your message/i).first()
      await composer.click()
      const cdp = await context.newCDPSession(page)
      await cdp.send("Profiler.enable")
      let offset
      await run({
        async arm(counters) {
          const before = now()
          const pageTime = await page.evaluate(() => window.__perf.now())
          offset = pageTime - (before + now()) / 2
          await page.evaluate(() => window.__perf.arm(false))
          if (counters) {
            await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false })
            await cdp.send("Profiler.takePreciseCoverage")
          }
        },
        async collect() {
          const value = await page.evaluate(() => window.__perf.collect())
          return { ...value, shown: Object.fromEntries(Object.entries(value.shown).map(([key, time]) => [key, time - offset])) }
        },
        async coverage() {
          const { result } = await cdp.send("Profiler.takePreciseCoverage")
          await cdp.send("Profiler.stopPreciseCoverage")
          return result.filter(script => /\/assets\/[^/]+\.js$/.test(script.url)).map(script => ({
            url: new URL(script.url).pathname.split("/").pop(),
            fns: script.functions.filter(fn => fn.ranges[0].count > 0).map(fn => [fn.functionName, fn.ranges[0].startOffset, fn.ranges[0].count]),
          }))
        },
        async typeKey(i) {
          await composer.evaluate(element => {
            element.focus()
            window.__perf.clearKey(element)
          })
          const start = now()
          await composer.press(String.fromCharCode(97 + i))
          const at = await page.waitForFunction(() => window.__perf.keyAt(), undefined, { timeout: 10_000, polling: 25 })
          try { return await at.jsonValue() - offset - start } finally { await at.dispose() }
        },
        async clear() {
          await page.evaluate(() => window.__perf.disarm())
          await composer.fill("")
          if (failures.length) throw Error(`Renderer error: ${failures.join("; ")}`)
        },
      })
    } finally {
      try { await context?.close() } finally {
        if (socketDir) await rm(socketDir, { recursive: true, force: true })
      }
    }
  })
}
