#!/usr/bin/env node
// The shared fixture daemon entry: one canonical Vite server per machine,
// discoverable through a ready file, controlled over HTTP by borrowers.
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server.ts"
import { readyDirectoryFor } from "./paths.ts"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const readyDirectory = process.env.CODENOMAD_FIXTURE_READY_DIR ?? readyDirectoryFor(uiRoot)
const readyFile = path.join(readyDirectory, "ready")
const idleTimeoutMs = 10 * 60 * 1000

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

const daemon = await startFixtureDaemon({ directory: uiRoot })
let lastActivity = Date.now()
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
    } catch (error) { response.statusCode = 409; response.end(String(error)) }
    return true
  }
  return false
})

await daemon.warmup({ routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/alert-dialog.tsx"></script></body></html>' }] })
await daemon.announce(readyFile)

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > idleTimeoutMs) void shutdown(0)
}, 30_000)
idleTimer.unref()

async function shutdown(code) {
  clearInterval(idleTimer)
  try { await daemon.close() } catch { /* the ready file is removed regardless */ }
  await rm(readyDirectory, { recursive: true, force: true })
  process.exit(code)
}
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
console.log(JSON.stringify({ kind: "fixture-daemon", port: daemon.port, pid: process.pid, readyFile }))
