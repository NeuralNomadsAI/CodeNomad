import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"

const html = (script: string) => `<html><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`
const script = "/tests/browser/fixtures/alert-dialog.tsx"
const definition = { name: "borrow-check", routes: [{ path: "/fixture/borrow-check", html: html(script) }] }

// A private discovery directory isolates this test's daemon lifecycle from any
// machine-wide daemon other files are borrowing through.
const isolation = await mkdtemp(path.join(tmpdir(), "borrow-check-"))
const readyDirectory = path.join(isolation, "discovery")
const options = { readyDirectory }

after(async () => {
  const { readFile } = await import("node:fs/promises")
  const ready = await readFile(path.join(readyDirectory, "ready"), "utf8").then(JSON.parse, () => null)
  if (ready) process.kill(ready.pid, "SIGTERM")
  await new Promise(resolve => setTimeout(resolve, 500))
  await rm(isolation, { recursive: true, force: true })
})

test("linux borrowers lazily spawn the daemon and re-register idempotently", { timeout: 120_000 }, async t => {
  if (process.platform !== "linux") return t.skip("daemon path is linux-only")
  const first = await borrowFixture(definition, options)
  t.after(() => first.close())
  assert.match(first.url, /\/borrow-check\/fixture\/borrow-check$/)
  assert.match(await (await fetch(first.url)).text(), new RegExp(`src="${script}"`))
  const second = await borrowFixture(definition, options)
  assert.equal(second.url, first.url)
})

test("a killed daemon respawns once and a persistent failure surfaces diagnostics", { timeout: 120_000 }, async t => {
  if (process.platform !== "linux") return t.skip("daemon path is linux-only")
  const { readFile } = await import("node:fs/promises")
  const ready = JSON.parse(await readFile(path.join(readyDirectory, "ready"), "utf8"))
  process.kill(ready.pid, "SIGKILL")
  await new Promise(resolve => setTimeout(resolve, 300))
  const revived = await borrowFixture({ name: "borrow-revive", routes: [{ path: "/fixture/borrow-revive", html: html(script) }] }, options)
  t.after(() => revived.close())
  assert.equal((await fetch(revived.url)).status, 200)

  // A deterministic persistent failure: re-registering a name with a different
  // payload is rejected on both attempts and the error names the ready file.
  await assert.rejects(borrowFixture({ name: "borrow-revive", routes: [{ path: "/fixture/other", html: html(script) }] }, options),
    /failed twice.*ready|already registered with a different payload/)
})

test("off linux each borrower runs its own canonical server and closes it", { timeout: 60_000 }, async () => {
  const fixture = await borrowFixture(definition, { ...options, platform: "win32" })
  assert.match(await (await fetch(fixture.url)).text(), new RegExp(`src="${script}"`))
  await fixture.close()
  await assert.rejects(fetch(fixture.url))
})
