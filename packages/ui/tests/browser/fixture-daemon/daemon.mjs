#!/usr/bin/env node
// The shared fixture daemon entry: one canonical Vite server per machine,
// discoverable through a ready file, controlled over HTTP by borrowers.
import { createHash } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFixtureDaemon } from "./server.ts"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const runKey = createHash("sha1").update(uiRoot).digest("hex").slice(0, 12)
const readyDirectory = path.join(tmpdir(), `codenomad-fixture-daemon-${runKey}`)
const readyFile = path.join(readyDirectory, "ready")
const idleTimeoutMs = 10 * 60 * 1000

const daemon = await startFixtureDaemon({ directory: uiRoot, readyFile })
let lastActivity = Date.now()
daemon.installControl(async (request, response) => {
  if (!request.url?.startsWith("/__daemon/")) return false
  lastActivity = Date.now()
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
