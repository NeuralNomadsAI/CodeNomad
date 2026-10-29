import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const html = (script: string) => `<html><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`
const script = "/tests/browser/fixtures/alert-dialog.tsx"

let cacheDir: string
before(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), "daemon-test-")) })
after(async () => { await rm(cacheDir, { recursive: true, force: true }) })

test("the daemon serves registered fixtures and re-registers idempotently", { timeout: 120_000 }, async t => {
  const daemon = await startFixtureDaemon({ directory: uiRoot, cacheDir })
  t.after(async () => { await daemon.close(); await rm(cacheDir, { recursive: true, force: true }) })

  const url = await daemon.register({ name: "alert-dialog", routes: [{ path: "/fixture/alert-dialog", html: html(script) }] })
  assert.equal(url, `${daemon.baseUrl}/fixture/alert-dialog`)
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), new RegExp(`src="${script}"`))

  // Idempotent: the same payload returns the same URL without error.
  assert.equal(await daemon.register({ name: "alert-dialog", routes: [{ path: "/fixture/alert-dialog", html: html(script) }] }), url)

  // Concurrent registrations of distinct fixtures both serve.
  const [second, third] = await Promise.all([
    daemon.register({ name: "alert-dialog-variant", routes: [{ path: "/fixture/alert-dialog-variant", html: html(script) }] }),
    daemon.register({ name: "alert-dialog-other", routes: [{ path: "/fixture/alert-dialog-other", html: html(script) }] }),
  ])
  for (const target of [second, third]) assert.equal((await fetch(target)).status, 200)

  // Warmup loads a real page once; serving the same module afterwards is a cache hit.
  await daemon.warmup({ routes: [{ path: "/__warmup", html: html(script) }] })
  const before = daemon.stats.transforms
  const warmed = await fetch(`${daemon.baseUrl}${script}`)
  assert.equal(warmed.status, 200)
  await warmed.text()
  assert.equal(daemon.stats.transforms, before, "the warmed module graph must not transform again")

  await daemon.close()
  await assert.rejects(fetch(url))
})

test("a late dependency outside the warmed graph loads in a real browser without a 504", { timeout: 180_000 }, async t => {
  const daemon = await startFixtureDaemon({ directory: uiRoot, cacheDir })
  t.after(async () => { await daemon.close().catch(() => {}); await rm(cacheDir, { recursive: true, force: true }) })

  // Warm the graph on one module…
  await daemon.warmup({ routes: [{ path: "/__warmup", html: html(script) }] })

  // …then register a fixture whose module warmup never saw. The #1139
  // review's optimizer-invalidation regression: a real browser loads the
  // page, the optimizer discovers the imports late, and no request may 504
  // as an outdated optimized dep — per-borrower servers were the race.
  const lateScript = "/tests/browser/fixtures/history-navigation.tsx"
  const late = await daemon.register({ name: "late-dependency", routes: [{ path: "/fixture/late-dependency", html: html(lateScript) }] })
  const { chromium } = await import("playwright")
  const { armFixtureNavigationBudget } = await import("../fixture-navigation-budget")
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(() => browser.close())
  const statuses: Array<{ url: string, status: number }> = []
  const page = await browser.newPage()
  page.on("response", response => { if (response.url().startsWith(daemon.baseUrl)) statuses.push({ url: response.url(), status: response.status() }) })
  await page.goto(late, { waitUntil: "load" })
  assert.ok(statuses.length > 0, "the page made requests against the daemon")
  const outdated = statuses.filter(entry => entry.status === 504 || entry.status === 500)
  assert.deepEqual(outdated.map(entry => entry.url), [], "no late-discovered dependency may 504")
  await page.close()
})
