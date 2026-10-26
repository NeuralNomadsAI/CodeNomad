#!/usr/bin/env node
// The shared fixture daemon entry: one canonical Vite server per machine,
// discoverable through a ready file, controlled over HTTP by borrowers.
import { mkdir, readFile, rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server.ts"
import { readyDirectoryFor } from "./paths.ts"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const readyDirectory = process.env.CODENOMAD_FIXTURE_READY_DIR ?? readyDirectoryFor(uiRoot)
const readyFile = path.join(readyDirectory, "ready")
const idleTimeoutMs = 10 * 60 * 1000
const warmupEnabled = process.env.CODENOMAD_FIXTURE_WARMUP !== "0"
const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID)
// The source trees whose transforms this daemon serves; an edit dated after
// start makes every later registration a lie about the code under test.
const freshnessRoots = [
  path.join(uiRoot, "src"),
  path.join(uiRoot, "tests/browser/fixtures"),
  path.resolve(uiRoot, "../server/src"),
]

// Claim the discovery directory atomically: yield to a live daemon, replace
// a stale claim left behind by an unclean shutdown.
let claimed = false
for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
  try { await mkdir(readyDirectory, { recursive: false }); claimed = true }
  catch (error) {
    if (error.code !== "EEXIST") throw error
    const existing = await readFile(readyFile, "utf8").then(JSON.parse, () => null)
    const alive = existing
      ? await fetch(`http://127.0.0.1:${existing.port}/__daemon/health`).then(() => true, () => false)
      : false
    if (alive) process.exit(0)
    await rm(readyDirectory, { recursive: true, force: true })
  }
}
if (!claimed) process.exit(0)

// Everything the daemon says — including crash traces — lands beside its
// ready file instead of a detached process's black hole.
const logStream = createWriteStream(path.join(readyDirectory, "daemon.log"), { flags: "a" })
const emit = (...args) => logStream.write(`${args.join(" ")}\n`)
const originalLog = console.log.bind(console), originalError = console.error.bind(console)
console.log = (...args) => { emit(...args); originalLog(...args) }
console.error = (...args) => { emit(...args); originalError(...args) }
process.on("uncaughtException", error => { emit("uncaughtException", error?.stack ?? String(error)); void shutdown(1) })

const daemon = await startFixtureDaemon({ directory: uiRoot, freshnessRoots })
let lastActivity = Date.now()

// A private fallback daemon (borrowFixture) is tied to its borrower: when the
// parent goes — even by SIGKILL, where no exit hook can run — this daemon
// follows rather than leaking a server nobody will ever find again.
if (Number.isInteger(parentPid) && parentPid > 0) {
  const parentWatch = setInterval(() => {
    try { process.kill(parentPid, 0) } catch { void shutdown(0) }
  }, 2_000)
  parentWatch.unref()
}
// Controls first, then startup warmup (one real page load settles Vite's lazy
// dependency discovery), and only then announce readiness: a borrower that
// wins the poll must never see a daemon whose controls or graph aren't ready.
daemon.installControl(async (request, response) => {
  lastActivity = Date.now() // every request keeps the daemon alive, not just control calls
  if (!request.url?.startsWith("/__daemon/")) return false
  if (request.url.split("?")[0] === "/__daemon/health") {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ pid: process.pid, ready: true }))
    return true
  }
  if (request.url.split("?")[0] === "/__daemon/register" && request.method === "POST") {
    if (request.headers["x-fixture-secret"] !== daemon.secret) { response.statusCode = 403; response.end("forbidden"); return true }
    const body = await new Promise(resolve => { let data = ""; request.on("data", chunk => data += chunk); request.on("end", () => resolve(data)) })
    try {
      const url = await daemon.register(JSON.parse(body))
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ url }))
    } catch (error) {
      response.statusCode = 409
      response.end(String(error))
      // A stale graph must not survive the rejection that exposed it.
      if (error?.code === "ERR_FIXTURE_DAEMON_STALE") void shutdown(0)
    }
    return true
  }
  return false
})

await daemon.announce(readyFile)
// Warm up after announcing: controls are already installed, so the health
// probe is honest; the first borrower may still pay part of the cold graph,
// but no spawn deadline is held hostage by a full page load. Private
// fallback daemons skip it — their first fixture page pays the cold graph
// exactly like the old per-file owned servers did.
if (warmupEnabled) {
  void daemon.warmup({ routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/alert-dialog.tsx"></script></body></html>' }] })
}

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > idleTimeoutMs) void shutdown(0)
}, 30_000)
idleTimer.unref()

// Sources edited since start invalidate the module graph even while the
// daemon sits idle between invocations: self-retire instead of serving
// transforms of code that no longer exists.
const { newestSourceMtime } = await import("./freshness.ts")
const staleWatch = setInterval(() => {
  void newestSourceMtime(freshnessRoots).then(newest => {
    if (newest > daemon.startedAt) { emit(JSON.stringify({ kind: "fixture-daemon-stale", newest })); void shutdown(0) }
  })
}, 30_000)
staleWatch.unref()

async function shutdown(code) {
  clearInterval(idleTimer)
  emit(JSON.stringify({ kind: "fixture-daemon-shutdown", rssMB: Math.round(process.memoryUsage().rss / 1048576), transforms: daemon.stats.transforms, registeredRoutes: daemon.registeredCount }))
  try { await daemon.close() } catch { /* the ready file is removed regardless */ }
  await rm(readyDirectory, { recursive: true, force: true })
  process.exit(code)
}
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
console.log(JSON.stringify({ kind: "fixture-daemon", port: daemon.port, pid: process.pid, readyFile }))
