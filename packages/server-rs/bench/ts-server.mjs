// The real TS server of this checkout on the fixture daemon only: discovery returns its endpoint, ensure/restart are refused.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import tls from "node:tls"
import { fileURLToPath } from "node:url"
import { dist, fromDist } from "./fixtures.mjs"

const { OpenCodeCliService } = await fromDist("workspaces/opencode-cli-service.js")
const { rememberRuntime } = await fromDist("opencode/compatibility/runtime.js")
const url = new URL(process.env.CNRS_FIXTURE_URL)
assert(url.hostname === "127.0.0.1" && url.protocol === "http:" && process.env.CNRS_FIXTURE_PASSWORD)
const password = process.env.CNRS_FIXTURE_PASSWORD
const info = await fetch(new URL("/api/info", url), { redirect: "error", signal: AbortSignal.timeout(5000),
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  .then(res => { assert.equal(res.status, 200); return res.json() })
assert.equal(info.pid, Number(process.env.CNRS_FIXTURE_PID))
// The saved Rust profile is verified against the bench's private CA, in this child only.
if (process.env.CNRS_FIXTURE_TRUSTED_CA)
  tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), await readFile(process.env.CNRS_FIXTURE_TRUSTED_CA, "utf8")])
const endpoint = { url: url.origin, auth: { type: "basic", username: "opencode", password } }
rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
OpenCodeCliService.prototype.discover = async () => endpoint
for (const action of ["ensure", "restart"]) OpenCodeCliService.prototype[action] = async () => { throw new Error(`Fixture forbids service ${action}`) }
const entry = new URL("index.js", dist)
process.argv[1] = fileURLToPath(entry)
await import(entry)
