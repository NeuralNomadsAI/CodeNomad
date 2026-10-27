#!/usr/bin/env node
// The fixture daemon entry: one canonical Vite server owned by the process
// that started it. A runner (run.mjs, shard.mjs) spawns this as a child and
// hands the endpoint to its test processes through the environment; a test
// file invoked on its own gets one from borrowFixture the same way. There is
// no discovery directory, no claim protocol and no adoption across runs —
// the endpoint and secret travel over the spawn, never through the
// filesystem.
import { mkdir } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server.ts"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const warmupEnabled = process.env.CODENOMAD_FIXTURE_WARMUP !== "0"
const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID)
const logDirectory = process.env.CODENOMAD_FIXTURE_LOG_DIR

// The endpoint handshake writes to a pipe owned by the spawning process;
// when that owner dies, writes raise EPIPE. Left unhandled it escalates
// into an uncaughtException loop inside the shutdown the parent watch has
// already started — swallow it: the watch is the intended exit path.
process.stdout?.on?.("error", error => { if (error?.code !== "EPIPE") throw error })

// Everything the daemon says — including crash traces — lands in daemon.log
// when the owner gave it a directory (runners do, so CI can upload it).
let flushLog = async () => {}
let logOnly = () => {}
if (logDirectory) {
  await mkdir(logDirectory, { recursive: true })
  const logStream = createWriteStream(path.join(logDirectory, "daemon.log"), { flags: "a" })
  const emit = (...args) => logStream.write(`${args.join(" ")}\n`)
  logOnly = emit
  const originalLog = console.log.bind(console), originalError = console.error.bind(console)
  console.log = (...args) => { emit(...args); originalLog(...args) }
  console.error = (...args) => { emit(...args); originalError(...args) }
  flushLog = async () => { await new Promise(resolve => logStream.end(resolve)) }
  process.on("uncaughtException", error => { emit("uncaughtException", error?.stack ?? String(error)); void shutdown(1) })
}

// Declared before any handler can fire: an early crash must not hit the
// temporal dead zone of the bindings shutdown uses.
let parentWatch = null
let shutdownPromise = null
let shutdownFailed = false

// A daemon is tied to the process that started it: when the owner goes —
// even by SIGKILL, where no exit hook can run — this daemon follows rather
// than leak a server nobody can find anymore.
if (Number.isInteger(parentPid) && parentPid > 0) {
  parentWatch = setInterval(() => {
    try { process.kill(parentPid, 0) } catch { void shutdown(0) }
  }, 2_000)
  parentWatch.unref()
}

// Declared with let and guarded everywhere: a startup failure must reach a
// flushing exit, not a temporal-dead-zone crash inside an error handler.
let daemon = null
try {
  daemon = await startFixtureDaemon({ directory: uiRoot })
} catch (error) {
  console.error(`fixture daemon failed to start: ${error?.stack ?? String(error)}`)
  process.exit(1)
}

// Controls first, then startup warmup (one real page load settles Vite's
// lazy dependency discovery), and only then announce the endpoint: an owner
// that wins the handshake must never see a daemon whose controls aren't
// ready. Warmup itself stays asynchronous — the owner may simply start
// borrowing while it settles.
daemon.installControl(async (request, response) => {
  if (!request.url?.startsWith("/__daemon/")) return false
  const route = request.url.split("?")[0]
  const authorized = request.headers["x-fixture-secret"] === daemon.secret

  if (route === "/__daemon/health") {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ pid: process.pid, ready: true }))
    return true
  }
  if (route === "/__daemon/register" && request.method === "POST") {
    if (!authorized) { response.statusCode = 403; response.end("forbidden"); return true }
    const body = await new Promise(resolve => { let data = ""; request.on("data", chunk => data += chunk); request.on("end", () => resolve(data)) })
    try {
      const url = await daemon.register(JSON.parse(body))
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ url }))
    } catch (error) { response.statusCode = 409; response.end(String(error)) }
    return true
  }
  if (route === "/__daemon/shutdown" && request.method === "POST") {
    if (!authorized) { response.statusCode = 403; response.end("forbidden"); return true }
    // Portable teardown: the owner asks over HTTP (a Windows process.kill
    // never runs signal handlers), the daemon cleans up and exits itself.
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ kind: "fixture-daemon-shutdown-ack" }))
    void shutdown(0)
    return true
  }
  return false
})

// The endpoint handshake: one JSON line on stdout — url, secret, pid. The
// spawning process reads it and passes it to the borrowers. It bypasses the
// console so the secret never reaches daemon.log, which CI uploads.
process.stdout.write(`${JSON.stringify({ kind: "fixture-daemon-endpoint", url: daemon.baseUrl, secret: daemon.secret, pid: process.pid })}\n`)
logOnly(JSON.stringify({ kind: "fixture-daemon-listening", url: daemon.baseUrl, pid: process.pid }))

if (warmupEnabled) {
  // A failed warmup (bad browser path, missing Chromium) degrades the first
  // borrower to a cold graph; it must never take an announced daemon down.
  daemon.warmup({ routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/alert-dialog.tsx"></script></body></html>' }] })
    .catch(error => console.error(JSON.stringify({ kind: "fixture-daemon-warmup-failed", error: String(error) })))
}

// One teardown per process: a second shutdown request, the parent watch or an
// error raised during cleanup joins the running teardown instead of exiting
// under it. A failed or hung cleanup exits nonzero, which the runner reports.
function shutdown(code) {
  if (code !== 0) shutdownFailed = true
  shutdownPromise ??= (async () => {
    if (parentWatch) clearInterval(parentWatch)
    setTimeout(() => process.exit(1), 10_000).unref()
    if (daemon) {
      console.log(JSON.stringify({ kind: "fixture-daemon-shutdown", rssMB: Math.round(process.memoryUsage().rss / 1048576), transforms: daemon.stats.transforms, registeredRoutes: daemon.registeredCount }))
      try {
        await daemon.close()
      } catch (error) {
        shutdownFailed = true
        console.error(JSON.stringify({ kind: "fixture-daemon-close-failed", error: error?.stack ?? String(error) }))
      }
    }
    await flushLog()
    process.exit(shutdownFailed ? 1 : 0)
  })()
  return shutdownPromise
}
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
