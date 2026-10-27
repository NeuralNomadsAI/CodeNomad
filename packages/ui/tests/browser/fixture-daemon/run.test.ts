import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
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

  // The log directory outlives it for post-mortem, with the protected
  // teardown's receipt and without the secret (CI uploads it).
  const log = await readFile(path.join(daemon.logDirectory, "daemon.log"), "utf8").catch(() => "")
  assert.ok(log.includes("\"kind\":\"fixture-shutdown\""), "daemon.log survives teardown and records the protected shutdown")
  assert.ok(!log.includes(daemon.secret), "daemon.log never records the endpoint secret")
})

test("concurrent shutdown requests share one teardown", { timeout: 180_000 }, async () => {
  const daemon = await startRunDaemon({ uiRoot, warmup: false })
  // Two shutdown requests pipelined on one connection: the second arrives
  // while the first teardown is running.
  const request = `POST /__daemon/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nx-fixture-secret: ${daemon.secret}\r\nContent-Length: 0\r\n\r\n`
  await new Promise<void>(resolve => {
    const socket = net.connect(Number(new URL(daemon.url).port), "127.0.0.1", () => socket.end(request + request))
    socket.resume()
    socket.on("close", () => resolve())
    socket.on("error", () => resolve())
  })
  // stop() resolves only for a zero exit, and the receipt shows the second
  // request joined the teardown instead of exiting under it.
  await Promise.all([daemon.stop(), daemon.stop()])
  const log = await readFile(path.join(daemon.logDirectory, "daemon.log"), "utf8")
  assert.ok(log.includes("\"kind\":\"fixture-shutdown\""), "the protected shutdown completed")
})

test("a runner sees a forced stop through, even with nothing else keeping it alive", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "run-forced-"))
  scratch.push(dir)
  // A daemon whose event loop blocks during shutdown: only the runner's
  // force-kill can end it.
  const wedged = path.join(dir, "wedged.mjs")
  await writeFile(wedged, [
    `import http from "node:http"`,
    `const server = http.createServer((request, response) => {`,
    `  response.end("ok")`,
    `  if (request.url === "/__daemon/shutdown") setImmediate(() => { for (;;) {} })`,
    `})`,
    `server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ kind: "fixture-daemon-endpoint", url: "http://127.0.0.1:" + server.address().port, secret: "s", pid: process.pid }) + "\\n"))`,
  ].join("\n"))
  // A runner with no other handles, like run.mjs and shard.mjs at the end of a slice.
  const runner = path.join(dir, "runner.mjs")
  await writeFile(runner, [
    `import { startRunDaemon } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "run.ts")).href)}`,
    `const daemon = await startRunDaemon({ uiRoot: ${JSON.stringify(uiRoot)}, script: ${JSON.stringify(wedged)}, timeoutMs: 20000 })`,
    `await daemon.stop().then(() => console.log("stop resolved"), error => console.log("stop rejected: " + error.message))`,
  ].join("\n"))
  const child = spawn(process.execPath, ["--import", "tsx", runner], { stdio: ["ignore", "pipe", "inherit"] })
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => { output += chunk })
  const code = await new Promise<number | null>(resolve => child.on("close", resolve))
  assert.match(output, /stop rejected: .*killed after 15 s/, `the runner reported the forced teardown (exit ${code}, output ${JSON.stringify(output)})`)
  assert.equal(code, 0)
})

test("the handshake reads whole lines and a failed start leaves no child behind", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "run-handshake-"))
  scratch.push(dir)
  // A record split across writes, preceded by output that mentions the marker.
  const split = path.join(dir, "split.mjs")
  await writeFile(split, [
    `process.stdout.write('warmup says "fixture-daemon-endpoint" soon\\n{"kind":"fixture-daemon-endpoint",')`,
    `setTimeout(() => process.stdout.write('"url":"http://127.0.0.1:9","secret":"s3cret","pid":' + process.pid + '}\\n'), 200)`,
    `setInterval(() => {}, 60000)`,
  ].join("\n"))
  const announced = await spawnDaemon({ uiRoot, script: split, timeoutMs: 20_000 })
  assert.equal(announced.url, "http://127.0.0.1:9")
  assert.equal(announced.secret, "s3cret")
  announced.child.kill()

  // A child that never announces is ended when the handshake times out.
  const silent = path.join(dir, "silent.mjs")
  const pidFile = path.join(dir, "silent.pid")
  await writeFile(silent, `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 60000)`)
  await assert.rejects(spawnDaemon({ uiRoot, script: silent, timeoutMs: 3_000 }), /did not announce/)
  const silentPid = Number(await readFile(pidFile, "utf8"))
  const deadline = Date.now() + 10_000
  while (alive(silentPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(!alive(silentPid), "the unannounced child was ended")
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
    `console.log(JSON.stringify({ pid: daemon.pid, logDirectory: daemon.logDirectory }))`,
    `setInterval(() => {}, 60000)`,
  ].join("\n"))
  const owner = spawn(process.execPath, ["--import", "tsx", probe], { stdio: ["ignore", "pipe", "ignore"] })
  let daemonPid = 0, logDirectory = ""
  owner.stdout.setEncoding("utf8")
  await new Promise<void>(resolve => owner.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.includes('"pid"')) { ({ pid: daemonPid, logDirectory } = JSON.parse(line)); resolve() }
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
  // It ran its own protected cleanup rather than dying with the owner.
  const log = await readFile(path.join(logDirectory, "daemon.log"), "utf8").catch(() => "")
  assert.ok(log.includes("\"kind\":\"fixture-shutdown\""), "the orphaned daemon completed its protected shutdown")
})
