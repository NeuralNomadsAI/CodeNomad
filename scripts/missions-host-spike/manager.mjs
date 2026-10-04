import { fork } from "node:child_process"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requestJson, writeJsonAtomic } from "./protocol.mjs"

const [profileDirectory, profile, authFile, sharedDaemonMarker] = process.argv.slice(2)
const registrationFile = path.join(profileDirectory, "host.json")
const generation = randomUUID()
const token = (await readFile(authFile, "utf8")).trim()
const backendToken = randomBytes(32).toString("hex")
const backendEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "backend-child.mjs")
let backend
let backendReady
let stopping = false
let fence = Promise.resolve()
let active = 0
let maximumActive = 0

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? ""
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

async function serializeAdmission(operation) {
  const previous = fence
  let release
  fence = new Promise(resolve => { release = resolve })
  await previous
  active += 1
  maximumActive = Math.max(maximumActive, active)
  try { return await operation() } finally { active -= 1; release() }
}

const control = createServer(async (request, response) => {
  try {
    if (!authorized(request)) return reply(response, 401, { error: "host-auth-required" })
    if (request.headers["x-codenomad-profile"] !== profile) return reply(response, 403, { error: "profile-origin-mismatch" })
    if (request.url === "/attach" && request.method === "POST") {
      const health = await requestJson(`${backendReady.url}/health`, backendToken, profile)
      return reply(response, 200, { managerPid: process.pid, generation, ...health })
    }
    if (request.url === "/status") {
      const health = await requestJson(`${backendReady.url}/health`, backendToken, profile)
      return reply(response, 200, { managerPid: process.pid, generation, maximumActive, ...health })
    }
    if (request.url === "/automation") return reply(response, 200, { available: false, reason: "no-attached-native-window" })
    if (request.url === "/admit" && request.method === "POST") {
      const result = await serializeAdmission(async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return requestJson(`${backendReady.url}/admit`, backendToken, profile, { method: "POST", body: "{}" })
      })
      return reply(response, 200, { ...result, managerPid: process.pid, generation })
    }
    if (request.url === "/stop" && request.method === "POST") {
      stopping = true
      await requestJson(`${backendReady.url}/stop`, backendToken, profile, { method: "POST", body: "{}" }).catch(() => undefined)
      const sharedDaemonUntouched = await readFile(sharedDaemonMarker, "utf8").then(value => value === "shared-daemon-owned-externally\n", () => false)
      reply(response, 200, { authorityStopped: true, sharedDaemonStopped: false, sharedDaemonUntouched })
      await rm(registrationFile, { force: true })
      control.close(() => process.exit(0))
      return
    }
    reply(response, 404, { error: "not-found" })
  } catch (error) {
    reply(response, 503, { error: error instanceof Error ? error.message : String(error) })
  }
})

backend = fork(backendEntry, [profile, backendToken, String(process.pid)], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
backendReady = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Private backend readiness timeout")), 5_000)
  backend.once("message", message => {
    if (message?.type !== "ready") return
    clearTimeout(timeout)
    resolve(message)
  })
  backend.once("error", reject)
})
backend.once("exit", () => { if (!stopping) process.exit(1) })

await new Promise(resolve => control.listen(0, "127.0.0.1", resolve))
const controlUrl = `http://127.0.0.1:${control.address().port}`
await writeJsonAtomic(registrationFile, {
  v: 1, profile, generation, managerPid: process.pid, backendPid: backendReady.pid,
  controlUrl, authOrigin: authFile, createdAt: Date.now(),
})

process.on("SIGTERM", () => process.exit(1))
process.on("exit", () => { if (!stopping) backend?.disconnect() })
