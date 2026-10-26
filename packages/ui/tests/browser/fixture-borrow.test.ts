import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { startFixtureDaemon } from "./fixture-daemon/server"

const html = "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/alert-dialog.tsx\"></script></body></html>"

const scratch: string[] = []
before(async () => { for (let i = 0; i < 8; i++) scratch.push(await mkdtemp(path.join(tmpdir(), "borrow-"))) })
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

test("with no shared daemon a borrower gets a private per-process daemon it reuses", { timeout: 120_000 }, async () => {
  const [probe, privateDirectory] = [scratch[0], scratch[1]]
  const first = await borrowFixture({ name: "borrow-private", routes: [{ path: "/fixture/borrow-private", html }] }, { readyDirectory: probe, privateDirectory })
  assert.equal((await fetch(first.url)).status, 200)

  const ready = JSON.parse(await readFile(path.join(privateDirectory, "ready"), "utf8"))
  assert.ok(ready.pid !== process.pid, "the private daemon is its own process, so the test process never holds Vite handles")
  assert.equal(typeof ready.secret, "string")

  const second = await borrowFixture({ name: "borrow-private-second", routes: [{ path: "/fixture/borrow-private-second", html }] }, { readyDirectory: probe, privateDirectory })
  assert.equal((await fetch(second.url)).status, 200)
  const reused = JSON.parse(await readFile(path.join(privateDirectory, "ready"), "utf8"))
  assert.equal(reused.pid, ready.pid, "a second borrow in the same process reuses the private daemon")
})

test("a healthy shared daemon in the discovery directory serves borrowers without spawning", { timeout: 120_000 }, async t => {
  const [sharedDirectory, privateDirectory] = [scratch[2], scratch[3]]
  const readyFile = path.join(sharedDirectory, "ready")
  const child = spawn(process.execPath,
    ["--import", "tsx", path.join(import.meta.dirname, "fixture-daemon", "daemon.mjs")],
    { stdio: "ignore", env: { ...process.env, CODENOMAD_FIXTURE_READY_DIR: sharedDirectory, CODENOMAD_FIXTURE_WARMUP: "0" } })
  t.after(() => { try { child.kill("SIGTERM") } catch { /* already gone */ } })
  const deadline = Date.now() + 60_000
  let ready: { port: number } | null = null
  while (Date.now() < deadline) {
    ready = await readFile(readyFile, "utf8").then(JSON.parse, () => null)
    if (ready && await fetch(`http://127.0.0.1:${ready.port}/__daemon/health`).then(r => r.ok, () => false)) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, "the spawned shared daemon became ready")

  const borrowed = await borrowFixture({ name: "borrow-shared", routes: [{ path: "/fixture/borrow-shared", html }] }, { readyDirectory: sharedDirectory, privateDirectory })
  assert.equal((await fetch(borrowed.url)).status, 200)
  assert.equal(new URL(borrowed.url).port, String(ready!.port), "the registration landed on the shared daemon")
  const after = JSON.parse(await readFile(readyFile, "utf8"))
  assert.equal(after.pid, child.pid, "no second daemon was spawned for the borrower")
})

test("a dead daemon in the discovery directory falls straight through to the private daemon", { timeout: 120_000 }, async () => {
  const [probe, privateDirectory] = [scratch[4], scratch[5]]
  const shared = await startFixtureDaemon({ directory: path.resolve(import.meta.dirname, "../.."), readyFile: path.join(probe, "ready") })
  await shared.announce(path.join(probe, "ready"))
  await shared.close() // the ready file survives an unclean end

  const started = Date.now()
  const borrowed = await borrowFixture({ name: "borrow-fallthrough", routes: [{ path: "/fixture/borrow-fallthrough", html }] }, { readyDirectory: probe, privateDirectory })
  assert.equal((await fetch(borrowed.url)).status, 200)
  assert.ok(Date.now() - started < 90_000, "no spawn deadline is held hostage polling a corpse")
})

test("the private daemon dies with its borrower process", { timeout: 120_000 }, async () => {
  const [probe, privateDirectory] = [scratch[6], scratch[7]]
  const probeScript = path.join(probe, "probe.mts")
  await writeFile(probeScript, [
    `import { borrowFixture } from ${JSON.stringify(path.join(import.meta.dirname, "fixture-borrow"))}`,
    `void (async () => {`,
    `  const fixture = await borrowFixture({ name: "borrow-exit", routes: [{ path: "/fixture/borrow-exit", html: ${JSON.stringify(html)} }] }, { readyDirectory: process.env.PROBE_READY_DIR!, privateDirectory: process.env.PROBE_PRIVATE_DIR! })`,
    `  if (!(await fetch(fixture.url)).ok) throw new Error("probe fixture did not serve")`,
    `  process.exit(0)`,
    `})()`,
  ].join("\n"))
  const child = spawn(process.execPath, ["--import", "tsx", probeScript],
    { stdio: "ignore", env: { ...process.env, PROBE_READY_DIR: probe, PROBE_PRIVATE_DIR: privateDirectory } })
  await new Promise<void>(resolve => child.on("close", () => resolve()))

  const ready = await readFile(path.join(privateDirectory, "ready"), "utf8").then(JSON.parse, () => null) as { pid: number } | null
  assert.ok(ready, "the borrower's private daemon announced itself")
  assert.notEqual(ready.pid, process.pid)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { process.kill(ready.pid, 0); await new Promise(resolve => setTimeout(resolve, 250)) }
    catch { return } // the daemon followed its borrower into the grave
  }
  assert.fail(`private daemon pid ${ready.pid} outlived its borrower process`)
})
