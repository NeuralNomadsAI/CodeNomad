import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"

const daemonScript = path.join(import.meta.dirname, "daemon.mjs")

const scratch: string[] = []
before(async () => { for (let i = 0; i < 3; i++) scratch.push(await mkdtemp(path.join(tmpdir(), "claim-"))) })
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

function startDaemon(readyDirectory: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", daemonScript],
    { stdio: "ignore", env: { ...process.env, CODENOMAD_FIXTURE_READY_DIR: readyDirectory, CODENOMAD_FIXTURE_WARMUP: "0" } })
}

async function awaitReady(readyDirectory: string, timeoutMs = 90_000): Promise<{ pid: number, port: number }> {
  const readyFile = path.join(readyDirectory, "ready")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await readFile(readyFile, "utf8").then(JSON.parse, () => null)
    if (ready && await fetch(`http://127.0.0.1:${ready.port}/__daemon/health`).then(r => r.ok, () => false)) return ready
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`daemon at ${readyDirectory} never became ready`)
}

const exited = (child: ChildProcess) => new Promise<number | null>(resolve => child.on("close", resolve))

test("concurrent starts yield to the live starter and reclaim only a dead owner's claim", { timeout: 180_000 }, async () => {
  const readyDirectory = scratch[0]

  // A live starter wins: the second daemon must yield, not replace it.
  const first = startDaemon(readyDirectory)
  const firstReady = await awaitReady(readyDirectory)
  const second = startDaemon(readyDirectory)
  assert.equal(await exited(second), 0, "the loser exits without a fight")
  assert.equal((await readFile(path.join(readyDirectory, "ready"), "utf8")).length > 0, true)
  const afterYield = JSON.parse(await readFile(path.join(readyDirectory, "ready"), "utf8"))
  assert.equal(afterYield.pid, firstReady.pid, "the first starter keeps the claim")

  // A dead owner's claim is reclaimed: pid verified gone before replacement.
  first.kill("SIGKILL") // no teardown handlers run: claim and ready survive
  await exited(first)
  const third = startDaemon(readyDirectory)
  const thirdReady = await awaitReady(readyDirectory)
  assert.equal(thirdReady.pid, third.pid, "the dead claim was replaced")
  third.kill("SIGTERM")
  await exited(third)
})

test("the discovery directory and ready file are private to their owner", { timeout: 180_000 }, async () => {
  const readyDirectory = scratch[1]
  const child = startDaemon(readyDirectory)
  try {
    await awaitReady(readyDirectory)
    const directoryMode = (await stat(readyDirectory)).mode & 0o777
    const readyMode = (await stat(path.join(readyDirectory, "ready"))).mode & 0o777
    assert.equal(directoryMode, 0o700, "the discovery directory is inaccessible to other local users")
    assert.equal(readyMode, 0o600, "the ready file carrying the secret is readable only by its owner")
  } finally {
    child.kill("SIGTERM")
    await exited(child)
  }
})

test("teardown keeps the daemon log for post-mortem and drops only the claim", { timeout: 180_000 }, async () => {
  const readyDirectory = scratch[2]
  const child = startDaemon(readyDirectory)
  await awaitReady(readyDirectory)
  child.kill("SIGTERM")
  await exited(child)

  assert.equal(await readFile(path.join(readyDirectory, "daemon.log"), "utf8").then(() => true, () => false), true,
    "the log outlives the daemon for post-mortem")
  for (const residue of ["ready", "claim"]) {
    assert.equal(await stat(path.join(readyDirectory, residue)).then(() => true, () => false), false,
      `${residue} must not survive its daemon`)
  }
})

test("a warmup failure is logged but never takes an announced daemon down", { timeout: 180_000 }, async () => {
  const readyDirectory = scratch[2]
  const child = spawn(process.execPath, ["--import", "tsx", daemonScript],
    { stdio: "ignore", env: { ...process.env, CODENOMAD_FIXTURE_READY_DIR: readyDirectory, CODENOMAD_FIXTURE_WARMUP: "1", CODENOMAD_BROWSER_PATH: "/nonexistent-chromium" } })
  try {
    const ready = await awaitReady(readyDirectory)
    // The warmup browser launch fails after announce; give the failure time
    // to fire and assert the daemon survives it.
    await new Promise(resolve => setTimeout(resolve, 6_000))
    assert.equal(await fetch(`http://127.0.0.1:${ready.port}/__daemon/health`).then(response => response.ok, () => false), true,
      "an announced daemon survives its warmup failure")
    const log = await readFile(path.join(readyDirectory, "daemon.log"), "utf8")
    assert.match(log, /warmup/, "the warmup failure is post-mortemable from the log")
  } finally {
    child.kill("SIGTERM")
    await exited(child)
  }
})

test("a starter that loses its claim still leaves its story in the log", { timeout: 180_000 }, async () => {
  const readyDirectory = scratch[2]
  // A live process holds the claim without ever becoming ready: the loser
  // must wait out its grace, refuse to steal, and exit non-zero — with the
  // reason in daemon.log, which must exist even though it never claimed.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"])
  await writeFile(path.join(readyDirectory, "claim"), JSON.stringify({ pid: holder.pid, startedAt: Date.now() }))
  const loser = spawn(process.execPath, ["--import", "tsx", daemonScript],
    { stdio: "ignore", env: { ...process.env, CODENOMAD_FIXTURE_READY_DIR: readyDirectory, CODENOMAD_FIXTURE_STARTER_GRACE_MS: "1200" } })
  try {
    const code = await exited(loser)
    assert.notEqual(code, 0, "the loser exits non-zero rather than stealing a live claim")
    const log = await readFile(path.join(readyDirectory, "daemon.log"), "utf8")
    assert.match(log, /never became ready/, "the pre-claim failure is in the log the runner can upload")
  } finally {
    holder.kill("SIGKILL")
    await exited(holder)
    await rm(path.join(readyDirectory, "claim"), { force: true })
  }
})
