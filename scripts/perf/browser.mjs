import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { privatePath } from "./isolation.mjs"
import { now } from "./lib.mjs"
import { withBackend } from "./stacks.mjs"

export async function withBrowser(daemon, tree, root, followLongReplies, run) {
  return withBackend(daemon, tree, root, followLongReplies, async (url, cookie) => {
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
      const transcript = page.locator(".message-stream").first()
      await transcript.press("End")
      await page.locator('.message-stream[data-follow-mode="following"]').first().waitFor()
      await composer.evaluate(element => element.focus({ preventScroll: true }))
      const cdp = await context.newCDPSession(page)
      await cdp.send("Profiler.enable")
      let offset
      await run({
        async arm(counters) {
          const before = now()
          const pageTime = await page.evaluate(() => window.__perf.now())
          offset = pageTime - (before + now()) / 2
          await page.evaluate(visibleOnly => window.__perf.arm(visibleOnly), !counters)
          if (counters) {
            await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false })
            await cdp.send("Profiler.takePreciseCoverage")
          }
        },
        async collect(withEvents = false) {
          const value = await page.evaluate(withEvents => window.__perf.collect(withEvents), withEvents)
          return { ...value, shown: Object.fromEntries(Object.entries(value.shown).map(([key, time]) => [key, time - offset])) }
        },
        async coverage() {
          const { result } = await cdp.send("Profiler.takePreciseCoverage")
          await cdp.send("Profiler.stopPreciseCoverage")
          return result.filter(script => /\/assets\/[^/]+\.js$/.test(script.url)).map(script => ({
            url: new URL(script.url).pathname.split("/").pop(),
            fns: script.functions.map(fn => [fn.functionName, fn.ranges[0].startOffset, fn.ranges[0].count]),
          }))
        },
        async typeKey(i) {
          await composer.evaluate(element => {
            element.focus({ preventScroll: true })
            window.__perf.clearKey(element)
          })
          const at = now()
          await page.keyboard.press(String.fromCharCode(97 + i))
          const painted = await page.waitForFunction(() => window.__perf.keyAt(), undefined, { timeout: 10_000, polling: 25 })
          try { return { at, elapsed: await painted.jsonValue() - offset - at } } finally { await painted.dispose() }
        },
        async clear() {
          await page.evaluate(() => window.__perf.disarm())
          await composer.fill("")
          if (failures.length) throw Error(`Renderer error: ${failures.join("; ")}`)
        },
      }).catch(async error => {
        const diagnostic = await transcript.evaluate(stream => {
          const pending = window.__perf.diagnostic()
          return { follow: stream.dataset.followMode, top: stream.scrollTop, height: stream.clientHeight, extent: stream.scrollHeight, pending }
        }).catch(() => null)
        if (diagnostic) await writeFile(path.join(root, "browser-observation.json"), JSON.stringify(diagnostic))
        throw error
      })
    } finally {
      try { await context?.close() } finally {
        if (socketDir) await rm(socketDir, { recursive: true, force: true })
      }
    }
  })
}
