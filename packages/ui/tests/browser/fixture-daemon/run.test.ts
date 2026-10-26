import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, test } from "node:test"
import { startRunDaemon, spawnDaemon } from "./run"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const scratch: string[] = []
after(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }) })

test("a runner's daemon serves its borrowers, keeps its log, and stops portably over HTTP", { timeout: 180_000 }, async () => {
  const daemon = await startRunDaemon({ uiRoot, warmup: false })
  assert.ok(daemon.url.startsWith("http://127.0.0.1:"), "the endpoint arrives over the spawn, not the filesystem")
  assert.ok(daemon.secret.length >= 16)
  assert.ok(alive(daemon.pid))

  // The env a runner hands its test processes attaches and registers.
  const register = await fetch(new URL("/__daemon/register", daemon.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-secret": daemon.secret },
    body: JSON.stringify({ name: "run-daemon-probe", routes: [{ path: "/fixture/run-daemon-probe", html: "<html><body></body></html>" }] }),
  })
  assert.equal(register.status, 200)
  const page = await fetch((await register.json()).url)
  assert.equal((await page.text()).includes("<html>"), true)

  // Shutdown is authenticated: a stranger's request changes nothing.
  const refused = await fetch(new URL("/__daemon/shutdown", daemon.url), { method: "POST", headers: { "x-fixture-secret": "wrong" } })
  assert.equal(refused.status, 403, "shutdown requires the daemon's secret")
  assert.ok(alive(daemon.pid), "a refused shutdown leaves the daemon serving")

  // The portable stop asks over HTTP, so the daemon's own cleanup runs on
  // every platform — a Windows process.kill never runs signal handlers.
  await daemon.stop()
  assert.ok(!alive(daemon.pid), "stop() ends the daemon")

  // The log directory outlives it for post-mortem.
  const log = await readFile(path.join(daemon.logDirectory, "daemon.log"), "utf8").then(() => true, () => false)
  assert.equal(log, true, "daemon.log survives teardown where CI can upload it")
})

test("a daemon follows its owner to the grave, even when the owner is killed", { timeout: 180_000 }, async () => {
  // A stand-in "runner": its death must take the daemon down without any
  // cleanup running — the parent watch, not the owner's goodwill, is the
  // guarantee. (Drive-letter-safe import: pathToFileURL, not a bare path.)
  const ownerDir = await mkdtemp(path.join(tmpdir(), "run-owner-"))
  const probe = path.join(ownerDir, "owner.mjs")
  await writeFile(probe, [
    `import { spawnDaemon } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "run.ts")).href)}`,
    `const daemon = await spawnDaemon({ uiRoot: ${JSON.stringify(uiRoot)}, warmup: false })`,
    `console.log(JSON.stringify({ pid: daemon.pid }))`,
    `setInterval(() => {}, 60000)`,
  ].join("\n"))
  const owner = spawn(process.execPath, ["--import", "tsx", probe], { stdio: ["ignore", "pipe", "ignore"] })
  let daemonPid = 0
  owner.stdout.setEncoding("utf8")
  await new Promise<void>(resolve => owner.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.includes('"pid"')) { daemonPid = JSON.parse(line).pid; resolve() }
    }
  }))
  assert.ok(daemonPid > 0 && alive(daemonPid), "the stand-in runner's daemon announced itself")

  owner.kill("SIGKILL") // no exit hooks, no cleanup, nothing
  // Reap the corpse: an unreaped zombie still answers kill(pid, 0), and the
  // parent watch must see its owner actually gone.
  await new Promise<void>(resolve => owner.on("close", () => resolve()))
  const deadline = Date.now() + 20_000
  while (alive(daemonPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(!alive(daemonPid), "the daemon followed its SIGKILLed owner")
})
