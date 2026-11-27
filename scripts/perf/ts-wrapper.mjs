// Attach the real backend to the owned fixture daemon; never start or stop a service.
import assert from "node:assert/strict"
import dgram from "node:dgram"
import net from "node:net"
import { register, syncBuiltinESMExports } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import { privatePath } from "./isolation.mjs"
import { createAttestedFetch, createAttestedPool, isInsideAttestedConnect, resolveWorktreePackage } from "../native-fixture-http.mjs"

const { Agent, setGlobalDispatcher } = await import(resolveWorktreePackage("undici"))

const config = process.argv[process.argv.indexOf("--config") + 1]
assert.equal(config, process.env.CLI_CONFIG)
const dist = pathToFileURL(`${process.env.PERF_SERVER_DIST}/`)
const { resolveConfigLocation } = await import(new URL("config/location.js", dist))
for (const p of Object.values(resolveConfigLocation(config))) privatePath(p)
register(new URL("loader.js", dist), import.meta.url)
const { OpenCodeCliService } = await import(new URL("workspaces/opencode-cli-service.js", dist))
const { rememberRuntime } = await import(new URL("opencode/compatibility/runtime.js", dist))
const url = new URL(process.env.PERF_DAEMON_URL)
assert.equal(url.hostname, "127.0.0.1")
const password = process.env.OPENCODE_SERVER_PASSWORD
const expectedPid = Number(process.env.PERF_DAEMON_PID)
const allowedOrigin = url.origin
const allowedPort = Number(url.port)
const endpoint = { url: allowedOrigin, auth: { type: "basic", username: "opencode", password } }
const probeFetch = createAttestedFetch(allowedOrigin, allowedPort, expectedPid)
let info
try {
  const response = await probeFetch(new URL("/api/info", url), {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  assert.equal(response.status, 200)
  info = await response.json()
} finally {
  await probeFetch.close()
}
assert.equal(info.pid, expectedPid)
rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
OpenCodeCliService.prototype.discover = async () => endpoint
for (const action of ["ensure", "restart"]) OpenCodeCliService.prototype[action] = async () => { throw Error(`Bench forbids service ${action}`) }
const entry = new URL("index.js", dist)
dgram.createSocket = () => { throw Error("Benchmark server cannot create UDP sockets") }
syncBuiltinESMExports()
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  let host, port, ipcPath
  if (Array.isArray(args[0])) args = args[0]
  if (typeof args[0] === "object" && args[0] !== null) {
    host = args[0].host
    port = Number(args[0].port)
    ipcPath = args[0].path
  } else if (typeof args[0] === "string" && Number.isNaN(Number(args[0]))) {
    ipcPath = args[0]
  } else {
    port = Number(args[0])
    host = typeof args[1] === "string" ? args[1] : undefined
  }
  if (ipcPath || port !== allowedPort || host !== "127.0.0.1") {
    throw Error(`Benchmark server cannot connect outside ${allowedOrigin}: ${ipcPath ?? `${host ?? "<unspecified>"}:${port}`}`)
  }
  if (!isInsideAttestedConnect()) {
    throw Error(`Benchmark server must use the attested HTTP pool for ${allowedOrigin}`)
  }
  return originalConnect.apply(this, args)
}
const { pool: attestedPool } = createAttestedPool(allowedOrigin, allowedPort, expectedPid)
const originalAgentDispatch = Agent.prototype.dispatch
Agent.prototype.dispatch = function guardedDispatch(opts, handler) {
  const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.origin
  if (origin !== allowedOrigin) {
    handler.onError?.(Error(`Benchmark server cannot contact external origin: ${origin}`))
    return false
  }
  return attestedPool.dispatch(opts, handler)
}
setGlobalDispatcher(attestedPool)
const baseFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const target = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(target.origin, allowedOrigin, `Benchmark server cannot contact external origin: ${target.origin}`)
  return baseFetch(input, { ...init, redirect: "error" })
}
process.argv[1] = fileURLToPath(entry)
await import(entry)
