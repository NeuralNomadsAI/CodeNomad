import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveConfigLocation } from "../config/location"
import { SettingsService } from "../settings/service"
import { verifiedDirectHttpsOrigin, verifiedHttpsOrigins } from "./direct-https"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

// A TLS-terminating reverse proxy forwards the public Host and the browser's Origin
// to the plain-HTTP listener, over loopback or from another machine.
const PUBLIC = "https://code.example.test"
const PUBLIC_HOST = "code.example.test"
const LAN_HTTP = "http://lan.example.test:9899"
const LAN_PEER = "192.0.2.20"

test("the verified direct HTTPS origin set and request predicate", () => {
  assert.deepEqual(verifiedHttpsOrigins({ localUrl: "https://127.0.0.1:9898", remoteUrl: "https://192.0.2.10:9898",
    addresses: [{ remoteUrl: "https://[::1]:9898" }, { remoteUrl: "https://lan.test:9898" }] as never },
  [PUBLIC, LAN_HTTP, "https://localhost:1", "https://app.localhost", "https://0.0.0.0:1", "https://[::]:1", "https://[::ffff:127.0.0.1]:1", "not a url"]),
  ["https://192.0.2.10:9898", "https://lan.test:9898", PUBLIC])
  const origins = [PUBLIC]
  const raw = { socket: undefined } as never
  const judge = (method: string, headers: Record<string, string | undefined>) => verifiedDirectHttpsOrigin({ raw, method, headers: headers as Record<string, string> }, origins)
  assert.equal(judge("POST", { origin: PUBLIC, host: "127.0.0.1:9899" }), PUBLIC)
  for (const headers of [{ host: PUBLIC_HOST }, { referer: `${PUBLIC}/`, host: PUBLIC_HOST }, { origin: "null" }, { origin: "" },
    { origin: "http://code.example.test" }, { origin: "https://code.example.test.evil.test" }, { origin: "https://localhost:8443" }]) {
    assert.equal(judge("POST", headers), null, JSON.stringify(headers))
  }
  assert.equal(judge("GET", { host: PUBLIC_HOST }), PUBLIC)
  assert.equal(judge("GET", { host: `${PUBLIC_HOST}:443` }), PUBLIC)
  assert.equal(judge("GET", { referer: `${PUBLIC}/app`, host: "127.0.0.1:9899" }), PUBLIC)
  for (const headers of [{ host: "127.0.0.1:9899" }, { host: `user@${PUBLIC_HOST}` }, { referer: "http://code.example.test/", host: PUBLIC_HOST },
    { origin: "null", host: PUBLIC_HOST }, { origin: LAN_HTTP, host: PUBLIC_HOST }, {}]) {
    assert.equal(judge("GET", headers), null, JSON.stringify(headers))
  }
  assert.equal(verifiedDirectHttpsOrigin({ raw, method: "GET", headers: { host: PUBLIC_HOST } }, []), null)
})

/** The real application and settings service; the host's opt-in lives in its `config.yaml`. */
async function surface(t: test.TestContext, enabled: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-direct-https-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const location = resolveConfigLocation(root)
  const setOptIn = (value: boolean) => fs.writeFileSync(location.configYamlPath, `server:\n  sidecarsOverDirectHttps: ${value}\n`)
  setOptIn(enabled)
  const settings = new SettingsService(location, undefined, { child() { return this }, warn() {}, info() {} } as never)
  // The tunnel origin is listed too: Remote Control ingress must never qualify, even then.
  const f = await startRemoteSurface(t, { settings, allowedOrigins: [PUBLIC, LAN_HTTP, "https://localhost:8443", `https://${FAKE_TUNNEL_HOST}`] })
  const cookie = `${f.authManager.getCookieName()}=${f.authManager.createSession("codenomad").id}`
  return { ...f, setOptIn, cookie }
}

test("the opt-in opens no other host-only path to a verified direct HTTPS origin", async t => {
  const f = await surface(t, true)
  for (const [method, url] of [["POST", "/api/auth/password"], ["POST", "/api/auth/token"], ["GET", "/auth/token"],
    ["GET", "/api/remote-control/devices"], ["POST", "/api/remote-control/start"], ["PUT", "/api/remote-control/previews"],
    ["POST", "/api/remote-proxy/sessions"], ["GET", "/api/remote-servers"], ["POST", "/api/opencode-plugin/automation"],
    ["GET", "/previews/missing/"], ["GET", "/sidecars"], ["GET", "/api/remote-%63ontrol/devices"]] as const) {
    for (const headers of [{ host: PUBLIC_HOST, origin: PUBLIC }, { host: PUBLIC_HOST }]) {
      const response = await f.app.inject({ method, url, remoteAddress: LAN_PEER, headers: { ...headers, cookie: f.cookie } })
      assert.equal(response.statusCode, 404, `${method} ${url} ${JSON.stringify(headers)}: ${response.body}`)
    }
  }
})

test("/api/meta reports sidecarsAllowed for local clients and opted-in verified direct HTTPS origins only", async t => {
  const f = await surface(t, false)
  const meta = async (remoteAddress: string, headers: Record<string, string>) => {
    const response = await f.app.inject({ url: "/api/meta", remoteAddress, headers: { ...headers, cookie: f.cookie } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { localRequest: boolean; sidecarsAllowed: boolean }
  }
  const verified: Record<string, string>[] = [{ host: PUBLIC_HOST }, { host: "127.0.0.1:9899", referer: `${PUBLIC}/` }, { host: PUBLIC_HOST, origin: PUBLIC }]
  const refused: Record<string, string>[] = [{ host: "lan.example.test:9899" }, { host: PUBLIC_HOST, origin: LAN_HTTP }, { host: PUBLIC_HOST, referer: `${LAN_HTTP}/` },
    { host: "localhost:8443" }, { host: PUBLIC_HOST, origin: "https://foreign.test" }, { host: "127.0.0.1:9899" }]
  for (const enabled of [false, true]) {
    f.setOptIn(enabled)
    const local = await meta("127.0.0.1", { host: "127.0.0.1:9899" })
    assert.deepEqual([local.localRequest, local.sidecarsAllowed], [true, true])
    for (const headers of verified) assert.equal((await meta(LAN_PEER, headers)).sidecarsAllowed, enabled, JSON.stringify(headers))
    for (const headers of refused) assert.equal((await meta(LAN_PEER, headers)).sidecarsAllowed, false, JSON.stringify(headers))
    for (const headers of [...verified, ...refused]) assert.equal((await meta(LAN_PEER, headers)).localRequest, false)
  }
  // Unauthenticated clients learn nothing.
  assert.equal((await f.app.inject({ url: "/api/meta", remoteAddress: LAN_PEER, headers: { host: PUBLIC_HOST } })).statusCode, 401)
})

function ingress(target: string, pathname: string, cookie: string): Promise<{ status: number; body: string }> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    http.get({ hostname, port: Number(port), path: pathname, agent: false, headers: { host: FAKE_TUNNEL_HOST, cookie } }, response => {
      let body = ""
      response.setEncoding("utf8").on("data", chunk => { body += chunk }).on("end", () => resolve({ status: response.statusCode ?? 0, body }))
    }).on("error", reject)
  })
}

test("Remote Control ingress never gains SideCars through the opt-in, even with its origin listed", async t => {
  const f = await surface(t, true)
  const paired = await new Promise<string>((resolve, reject) => {
    const [hostname, port] = f.target().split(":")
    const request = http.request({ hostname, port: Number(port), path: "/api/remote-control/pair", method: "POST", agent: false,
      headers: { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, "content-type": "application/json" } }, response => {
      response.resume()
      response.statusCode === 200 ? resolve(String(response.headers["set-cookie"]).split(";")[0]!) : reject(new Error(`pairing ${response.statusCode}`))
    })
    request.on("error", reject)
    request.end(JSON.stringify({ code: f.code }))
  })
  assert.equal((await ingress(f.target(), "/sidecars/fixture/", paired)).status, 404)
  const meta = await ingress(f.target(), "/api/meta", paired)
  assert.equal(meta.status, 200, meta.body)
  assert.equal(JSON.parse(meta.body).sidecarsAllowed, false)
})
