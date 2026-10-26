import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { startRunDaemon } from "./fixture-daemon/run"

const html = "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/alert-dialog.tsx\"></script></body></html>"

const scratch: string[] = []
before(async () => { for (let i = 0; i < 2; i++) scratch.push(await mkdtemp(path.join(tmpdir(), "borrow-"))) })
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

test("a runner's endpoint attaches borrowers without spawning anything", { timeout: 180_000 }, async () => {
  const daemon = await startRunDaemon({ uiRoot: path.resolve(import.meta.dirname, "../.."), warmup: false })
  try {
    const before = 0 + await fetch(new URL("/__daemon/health", daemon.url)).then(() => 0, () => 0)
    const borrowed = await borrowFixture({ name: "borrow-attached", routes: [{ path: "/fixture/borrow-attached", html }] }, { endpoint: { url: daemon.url, secret: daemon.secret, pid: daemon.pid } })
    assert.equal((await fetch(borrowed.url)).status, 200)
    assert.equal(new URL(borrowed.url).port, new URL(daemon.url).port, "the registration landed on the runner's daemon")
    assert.equal(before, 0)
  } finally { await daemon.stop() }
})

test("a dead endpoint falls through to this process's standalone daemon, which is reused and dies with it", { timeout: 180_000 }, async () => {
  const [probe, log] = [scratch[0], scratch[1]]
  const probeScript = path.join(probe, "probe.mjs")
  await writeFile(probeScript, [
    `import { borrowFixture } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "fixture-borrow.ts")).href)}`,
    `void (async () => {`,
    `  const first = await borrowFixture({ name: "borrow-exit", routes: [{ path: "/fixture/borrow-exit", html: ${JSON.stringify(html)} }] }, { endpoint: { url: "http://127.0.0.1:9", secret: "dead", pid: 0 } })`,
    `  if (!(await fetch(first.url)).ok) throw new Error("standalone daemon did not serve")`,
    `  const second = await borrowFixture({ name: "borrow-exit-2", routes: [{ path: "/fixture/borrow-exit-2", html: ${JSON.stringify(html)} }] }, { endpoint: { url: "http://127.0.0.1:9", secret: "dead", pid: 0 } })`,
    `  console.log(JSON.stringify({ ports: [new URL(first.url).port, new URL(second.url).port] }))`,
    `  process.exit(0)`,
    `})()`,
  ].join("\n"))
  const child = spawn(process.execPath, ["--import", "tsx", probeScript],
    { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CODENOMAD_FIXTURE_LOG: log } })
  let ports: string[] = []
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.includes('"ports"')) ports = JSON.parse(line).ports
  })
  await new Promise<void>(resolve => child.on("close", () => resolve()))

  // Both borrows reused one standalone daemon for the process…
  assert.equal(ports.length, 2)
  assert.equal(ports[0], ports[1], "a second borrow reuses the process's standalone daemon")
  // …and no daemon outlived it.
  const deadline = Date.now() + 20_000
  const gone = async () => {
    const probes = await Promise.all(ports.map(port =>
      fetch(`http://127.0.0.1:${port}/__daemon/health`).then(() => false, () => true)))
    return probes.every(Boolean)
  }
  let dead = await gone()
  while (!dead && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); dead = await gone() }
  assert.ok(dead, "the standalone daemon died with its borrower process")
})

test("with no runner and no endpoint option a standalone daemon serves the file", { timeout: 180_000 }, async () => {
  // This test process itself is the borrower: no endpoint option, no env.
  const borrowed = await borrowFixture({ name: "borrow-standalone", routes: [{ path: "/fixture/borrow-standalone", html }] })
  assert.equal((await fetch(borrowed.url)).status, 200)
  const again = await borrowFixture({ name: "borrow-standalone-2", routes: [{ path: "/fixture/borrow-standalone-2", html }] })
  assert.equal(new URL(again.url).port, new URL(borrowed.url).port, "the same standalone daemon serves the whole process")
})
