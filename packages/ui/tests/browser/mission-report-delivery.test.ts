import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { missionMessages as en } from "../../src/lib/i18n/messages/en/missions"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error", cacheDir: cache.cacheDir, plugins: [solid(), { name: "mission-report-delivery", configureServer(s) {
      s.middlewares.use("/mission-report-delivery", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-report-delivery", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-report-delivery.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-report-delivery`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close() } finally { try { await server?.close() } finally { await cache?.dispose() } } })
const replace = (page: Page, patch: unknown) => page.evaluate(patch => (window as any).missionReportDelivery.replace(patch), patch)
async function open() {
  const page = await browser.newPage({ locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.locator(".mission-native-execution").waitFor()
  return page
}

test("coordinator readout renders its own localized delivery without any notification status", async () => {
  const page = await open()
  try {
    for (const notificationStatus of [undefined, "pending", "admitted"]) {
      await replace(page, { notificationStatus })
      assert.equal(await page.locator("[data-notification]").count(), 0)
      await page.getByText("Coordinator business readout; no notification is sent.", { exact: true }).waitFor()
      assert.equal(await page.getByText(en["missions.control.report.delivery.coordinator"], { exact: true }).count(), 0)
    }
    assert.equal(await page.locator("code").count(), 0, "readout does not invent a child invocation")
  } finally { await page.close() }
})

test("native-return provenance and independent-root notification states survive delivery changes", async () => {
  const page = await open()
  try {
    const nativeCall = { generation: 2, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_child" }
    await replace(page, { delivery: "native-return", notificationStatus: "pending", nativeCall })
    await page.getByText(en["missions.control.report.delivery.nativeReturn"], { exact: true }).waitFor()
    await page.getByText(en["missions.control.report.notification.nativeReturnPending"], { exact: true }).waitFor()
    assert.equal(await page.locator("code").textContent(), "call_child")
    assert.match(await page.locator("code").getAttribute("title") ?? "", /2 · ses_parent · msg_parent · call_child/)
    await replace(page, { delivery: "coordinator-readout", nativeCall })
    assert.equal(await page.locator("[data-notification]").count(), 0)
    assert.equal(await page.locator("code").textContent(), "call_child", "recorded provenance is preserved, not inferred from delivery")
    for (const delivery of ["native-return", "coordinator-notification", undefined]) {
      for (const notificationStatus of [undefined, "pending", "admitted"]) {
        await replace(page, { delivery, notificationStatus })
        const key = delivery === "native-return" && notificationStatus === "pending" ? "nativeReturnPending" : notificationStatus ?? "unknown"
        await page.getByText(en[`missions.control.report.notification.${key}` as keyof typeof en], { exact: true }).waitFor()
        assert.equal(await page.locator("[data-notification]").getAttribute("data-notification"), notificationStatus ?? "unknown")
        if (delivery === "coordinator-notification") await page.getByText(en["missions.control.report.delivery.coordinator"], { exact: true }).waitFor()
      }
    }
  } finally { await page.close() }
})

test("readout delivery renders the selected dictionary in all ten locales", async () => {
  for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { missionMessages } = await import(`../../src/lib/i18n/messages/${locale}/missions.ts`)
    const page = await browser.newPage()
    try {
      await page.route("**/api/**", route => route.fulfill({ json: route.request().url().endsWith("/storage/config/ui")
        ? { settings: { locale } } : {} }))
      await page.goto(url)
      await page.getByText(missionMessages["missions.control.report.delivery.readout"], { exact: true }).waitFor()
      assert.equal(await page.locator("[data-notification]").count(), 0, locale)
    } finally { await page.close() }
  }
})
