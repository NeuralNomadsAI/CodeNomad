// The real TS server of this checkout. With `CNRS_FIXTURE_URL`, on the fixture daemon only: discovery
// returns its endpoint, ensure/restart are refused. Without it, its own CLI lifecycle (`service.mjs`).
import assert from "node:assert/strict"
import { readFile, realpath } from "node:fs/promises"
import tls from "node:tls"
import { fileURLToPath } from "node:url"
import { dist, ensureDist, fromDist } from "./fixtures.mjs"
ensureDist()

if (process.env.CNRS_FIXTURE_URL) {
  const { OpenCodeCliService } = await fromDist("workspaces/opencode-cli-service.js")
  const { rememberRuntime } = await fromDist("opencode/compatibility/runtime.js")
  const url = new URL(process.env.CNRS_FIXTURE_URL)
  assert(url.hostname === "127.0.0.1" && url.protocol === "http:" && process.env.CNRS_FIXTURE_PASSWORD)
  const password = process.env.CNRS_FIXTURE_PASSWORD
  const info = await fetch(new URL("/api/info", url), { redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
    .then(res => { assert.equal(res.status, 200); return res.json() })
  assert.equal(info.pid, Number(process.env.CNRS_FIXTURE_PID))
  const endpoint = { url: url.origin, auth: { type: "basic", username: "opencode", password } }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  OpenCodeCliService.prototype.discover = async () => endpoint
  for (const action of ["ensure", "restart"]) OpenCodeCliService.prototype[action] = async () => { throw new Error(`Fixture forbids service ${action}`) }
}
if (process.env.CNRS_FIXTURE_RELEASES) {
  const { Agent, setGlobalDispatcher } = await import("undici")
  const fixture = new URL(process.env.CNRS_FIXTURE_RELEASES)
  assert.equal(fixture.href, `${fixture.origin}/`)
  assert(fixture.hostname === "127.0.0.1" && fixture.protocol === "http:" && fixture.port)
  setGlobalDispatcher(new class extends Agent {
    dispatch(options, handler) {
      if (String(options.origin) === "https://api.github.com" && options.path.startsWith("/repos/NeuralNomadsAI/CodeNomad/releases"))
        return super.dispatch({ ...options, origin: fixture.origin }, handler)
      return super.dispatch(options, handler)
    }
  }())
}
// `providers` mode: every HTTPS request goes to the bench's fake provider (`https://host/path` →
// `<fake>/host/path`), so no provider is ever contacted.
if (process.env.CNRS_FIXTURE_PROVIDERS) {
  const fake = new URL(process.env.CNRS_FIXTURE_PROVIDERS)
  assert(fake.hostname === "127.0.0.1" && fake.protocol === "http:")
  const real = globalThis.fetch
  const { googleOAuthClients } = await fromDist("usage/google-credential.js")
  googleOAuthClients.get = () => ({ client_id: "fixture-client-id", client_secret: "fixture-client-secret" })
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol === "https:") {
      input = `${fake.origin}/${url.host}${url.pathname}${url.search}`
      return real(input, { ...init, redirect: init?.redirect === "error" ? "error" : "manual" })
    }
    assert(url.protocol === "http:" && url.hostname === "127.0.0.1", "Provider bench refuses external HTTP")
    return real(input, init)
  }
}
// The saved Rust profile is verified against the bench's private CA, in this child only.
if (process.env.CNRS_FIXTURE_TRUSTED_CA)
  tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), await readFile(process.env.CNRS_FIXTURE_TRUSTED_CA, "utf8")])
const entry = new URL("index.js", dist)
if (process.env.CNRS_PREVIEW_TEST_TUNNEL === "1") {
  const { RemoteControlManager } = await fromDist("remote-control/manager.js")
  const start = RemoteControlManager.prototype.start
  RemoteControlManager.prototype.start = function () {
    this.options.openTunnel = async ({ target }) => {
      assert.match(target, /^127\.0\.0\.1:\d+$/)
      const hostname = "preview-ingress.fixture.test"
      let close
      const closed = new Promise(resolve => { close = resolve })
      console.log(`CNRS_TEST_INGRESS http://${target}`)
      return { hostname, url: `https://${hostname}`, closed, close: async () => close(),
        status: () => ({ state: "connected", connections: 0 }) }
    }
    return start.call(this)
  }
}
// Match index.js's import.meta.url even when dist is a junction to a separate reference build.
process.argv[1] = await realpath(fileURLToPath(entry))
await import(entry)
