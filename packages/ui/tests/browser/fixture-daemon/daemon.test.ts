import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { startFixtureDaemon } from "./server"

const uiRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..")
const html = (script: string) => `<html><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`
const script = "/tests/browser/fixtures/alert-dialog.tsx"

let cacheDir: string, readyFile: string
before(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "daemon-test-"))
  readyFile = path.join(await mkdtemp(path.join(tmpdir(), "daemon-ready-")), "ready")
})
after(async () => { await rm(cacheDir, { recursive: true, force: true }); await rm(path.dirname(readyFile), { recursive: true, force: true }) })

test("the daemon serves registered fixtures and re-registers idempotently", { timeout: 120_000 }, async t => {
  const daemon = await startFixtureDaemon({ directory: uiRoot, cacheDir, readyFile })
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

  // The ready file carries everything a borrower needs to find the daemon.
  const ready = JSON.parse(await readFile(readyFile, "utf8"))
  assert.equal(ready.port, daemon.port)
  assert.ok(Number.isInteger(ready.pid))
  assert.ok(ready.secret.length >= 16)

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
