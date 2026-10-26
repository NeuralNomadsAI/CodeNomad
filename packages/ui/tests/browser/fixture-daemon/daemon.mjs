#!/usr/bin/env node
// The shared fixture daemon entry: one canonical Vite server per machine,
// discoverable through a ready file, controlled over HTTP by borrowers.
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server.ts"
import { readyDirectoryFor } from "./paths.ts"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const readyDirectory = process.env.CODENOMAD_FIXTURE_READY_DIR ?? readyDirectoryFor(uiRoot)
const readyFile = path.join(readyDirectory, "ready")
const claimFile = path.join(readyDirectory, "claim")
const idleTimeoutMs = 10 * 60 * 1000
// Longer than a starter's own spawn budget, so a healthy-but-slow starter is
// never declared dead by the peer waiting on it; tunable for tests.
const starterGraceMs = Number(process.env.CODENOMAD_FIXTURE_STARTER_GRACE_MS ?? 95_000)
const warmupEnabled = process.env.CODENOMAD_FIXTURE_WARMUP !== "0"
const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID)
// The source trees whose transforms this daemon serves; an edit dated after
// start makes every later registration a lie about the code under test.
const freshnessRoots = [
  path.join(uiRoot, "src"),
  path.join(uiRoot, "tests/browser/fixtures"),
  path.resolve(uiRoot, "../server/src"),
]

const pidAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = (file, fallback = null) => readFile(file, "utf8").then(JSON.parse, () => fallback)
// The health endpoint reports the serving process's pid; a ready file whose
// port now serves a different process (stale file plus port reuse) must not
// be mistaken for the daemon it names.
const serving = async ready => Boolean(ready && await fetch(`http://127.0.0.1:${ready.port}/__daemon/health`, { signal: AbortSignal.timeout(5_000) })
  .then(response => (response.ok ? response.json() : null))
  .then(body => body?.ready === true && body.pid === ready.pid)
  .catch(() => false))

// Claim the discovery directory through an exclusive claim file. The
// directory itself persists at 0700 so the daemon log survives teardown;
// `claim` names the current owner (pid-verified before anyone replaces it)
// and `ready` appears only once the daemon can serve. A starter whose owner
// is alive is waited for and yielded to — never removed out from under it.
await mkdir(readyDirectory, { recursive: true })
const directoryStat = await stat(readyDirectory)
if (typeof process.getuid === "function" && process.getuid() !== directoryStat.uid) {
  console.error(`refusing to use ${readyDirectory}: another local user owns it`)
  process.exit(1)
}
await chmod(readyDirectory, 0o700)

// Everything the daemon says — including claim-protocol refusals and crash
// traces, which happen before any claim is won — lands in daemon.log beside
// the discovery files instead of a detached process's black hole.
const logStream = createWriteStream(path.join(readyDirectory, "daemon.log"), { flags: "a" })
const emit = (...args) => logStream.write(`${args.join(" ")}\n`)
const originalLog = console.log.bind(console), originalError = console.error.bind(console)
console.log = (...args) => { emit(...args); originalLog(...args) }
console.error = (...args) => { emit(...args); originalError(...args) }
process.on("uncaughtException", error => { emit("uncaughtException", error?.stack ?? String(error)); void shutdown(1) })

// Declared before any handler can fire: an early crash must not hit the
// temporal dead zone of interval bindings shutdown clears.
let idleTimer = null, staleWatch = null

// Flush the log before an abnormal exit so the refusal itself is
// post-mortemable; the intercept's writes are buffered until the stream ends.
const die = async message => { console.error(message); await new Promise(resolve => logStream.end(resolve)); process.exit(1) }

let claimed = false
for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
  try {
    await writeFile(claimFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx", mode: 0o600 })
    claimed = true
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const owner = await readJson(claimFile)
    if (owner === null) {
      // A claim file can exist before its content lands (create-with-flag is
      // not create-with-content). Give the writer a poll cycle before
      // treating a live owner's half-written claim as unowned residue.
      await sleep(250)
      owner = await readJson(claimFile)
    }
    if (owner && Number.isInteger(owner.pid) && pidAlive(owner.pid)) {
      const deadline = Date.now() + starterGraceMs
      while (Date.now() < deadline) {
        if (await serving(await readJson(readyFile))) process.exit(0) // yield to the live starter
        if (!pidAlive(owner.pid)) break // it died mid-start: reclaim below
        await sleep(250)
      }
      if (pidAlive(owner.pid)) await die(`claim at ${claimFile} held by live pid ${owner.pid} that never became ready`)
    }
    // The owner is verifiably gone: clear its residue and contend again.
    await rm(claimFile, { force: true })
    await rm(readyFile, { force: true })
  }
}
if (!claimed) await die(`could not claim ${claimFile}`)

// A failure between claiming and a live daemon (Vite refusing to start, a
// port problem, an optimizer crash) must flush its story and remove the
// claim — shutdown() cannot run here: the daemon object it reads does not
// exist yet, and an unguarded handler would die on the temporal dead zone
// instead of cleaning up.
let daemon = null
try {
  daemon = await startFixtureDaemon({ directory: uiRoot, freshnessRoots })
} catch (error) {
  await die(`fixture daemon failed to start: ${error?.stack ?? String(error)}`)
}
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
  // A failed warmup (bad browser path, missing Chromium) degrades the first
  // borrower to a cold graph; it must never take an announced daemon down.
  daemon.warmup({ routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/alert-dialog.tsx"></script></body></html>' }] })
    .catch(error => console.error(JSON.stringify({ kind: "fixture-daemon-warmup-failed", error: String(error) })))
}

idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > idleTimeoutMs) void shutdown(0)
}, 30_000)
idleTimer.unref()

// Sources edited since start invalidate the module graph even while the
// daemon sits idle between invocations: self-retire instead of serving
// transforms of code that no longer exists.
const { newestSourceMtime } = await import("./freshness.ts")
staleWatch = setInterval(() => {
  void newestSourceMtime(freshnessRoots).then(newest => {
    if (newest > daemon.startedAt) { emit(JSON.stringify({ kind: "fixture-daemon-stale", newest })); void shutdown(0) }
  })
}, 30_000)
staleWatch.unref()

async function shutdown(code) {
  clearInterval(idleTimer)
  clearInterval(staleWatch)
  emit(JSON.stringify({ kind: "fixture-daemon-shutdown", rssMB: Math.round(process.memoryUsage().rss / 1048576), transforms: daemon.stats.transforms, registeredRoutes: daemon.registeredCount }))
  try { await daemon.close() } catch { /* the claim files are removed regardless */ }
  await rm(readyFile, { force: true })
  await rm(claimFile, { force: true })
  // daemon.log stays beside the (persisting, 0700) directory for post-mortem;
  // flush it before exiting so the last lines are not lost to the stream.
  await new Promise(resolve => logStream.end(resolve))
  process.exit(code)
}
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
console.log(JSON.stringify({ kind: "fixture-daemon", port: daemon.port, pid: process.pid, readyFile }))
