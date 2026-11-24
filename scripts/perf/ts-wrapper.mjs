// Attach the real backend to the owned fixture daemon; never start or stop a service.
import assert from "node:assert/strict"
import { register } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import { privatePath } from "./isolation.mjs"
import { fixtureFetch, resolveWorktreePackage } from "../native-fixture-http.mjs"

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
const endpoint = { url: url.origin, auth: { type: "basic", username: "opencode", password } }
const info = await (await fixtureFetch(new URL("/api/info", url), { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })).json()
assert.equal(String(info.pid), process.env.PERF_DAEMON_PID)
rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
OpenCodeCliService.prototype.discover = async () => endpoint
for (const action of ["ensure", "restart"]) OpenCodeCliService.prototype[action] = async () => { throw Error(`Bench forbids service ${action}`) }
const entry = new URL("index.js", dist)
const allowedOrigin = url.origin
const innerDispatcher = new Agent()
setGlobalDispatcher({
  dispatch(opts, handler) {
    const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.origin
    if (origin !== allowedOrigin) {
      handler.onError?.(Error(`Benchmark server cannot contact external origin: ${origin}`))
      return false
    }
    return innerDispatcher.dispatch(opts, handler)
  },
  close: () => innerDispatcher.close(),
  destroy: err => innerDispatcher.destroy(err),
})
const baseFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const target = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(target.origin, allowedOrigin, `Benchmark server cannot contact external origin: ${target.origin}`)
  return baseFetch(input, { ...init, redirect: "error" })
}
process.argv[1] = fileURLToPath(entry)
await import(entry)
