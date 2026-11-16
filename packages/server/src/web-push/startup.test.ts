import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { resolveConfigLocation } from "../config/location"
import { startRemoteSurface } from "../remote-control/test-support/surface"
import { SettingsService } from "../settings/service"
import { PushService, type PushPrincipal } from "./service"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"

const origin = "https://push.example.test"
const principal: PushPrincipal = { id: "test-session", channel: "https", origin }
const malformed = Buffer.from('{"v":1,"private-sentinel":')

function storage(t: TestContext, bytes: Buffer, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-startup-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const location = resolveConfigLocation(root)
  fs.writeFileSync(location.configYamlPath, `ui:\n  settings:\n    multiBackend: ${enabled}\n`)
  const file = path.join(path.dirname(location.configYamlPath), "web-push.json")
  fs.writeFileSync(file, bytes)
  const settings = new SettingsService(location, undefined, { child() { return this }, warn() {}, info() {} } as never)
  return { file, settings }
}

function request(local: string, cookie: string, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(`http://${local}${url}`, {
      method,
      headers: { host: new URL(origin).host, origin, cookie, "content-type": "application/json", connection: "close" },
    }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, body }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

for (const mode of ["policy-disabled", "feature-off", "enabled"] as const) {
  test(`corrupt push storage preserves real listener startup: ${mode}`, async t => {
    const policy = process.env.CODENOMAD_WEB_PUSH
    process.env.CODENOMAD_WEB_PUSH = mode === "policy-disabled" ? "disabled" : ""
    t.after(() => {
      if (policy === undefined) delete process.env.CODENOMAD_WEB_PUSH
      else process.env.CODENOMAD_WEB_PUSH = policy
    })
    const { file, settings } = storage(t, malformed, mode !== "feature-off")
    const surface = await startRemoteSurface(t, { settings, allowedOrigins: [origin] })
    const cookie = `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}`
    const status = await request(surface.local, cookie, "GET", "/api/push/status")
    assert.equal(status.status, mode === "feature-off" ? 404 : 200, status.body)
    if (mode !== "feature-off") {
      assert.equal(JSON.parse(status.body).enabled, false)
      assert.equal(JSON.parse(status.body).subscribed, false)
    }
    const consent = await request(surface.local, cookie, "PUT", "/api/push/subscription", { consent: true })
    assert.equal(consent.status, mode === "feature-off" ? 404 : mode === "policy-disabled" ? 403 : 503, consent.body)
    if (mode === "enabled") assert.deepEqual(JSON.parse(consent.body), { error: "Push storage unavailable" })
    const pairing = surface.manager.createDirectPairing(origin)
    const device = surface.manager.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
    const logout = await request(surface.local, `${DEVICE_COOKIE_NAME}=${device.token}`, "POST", "/api/auth/logout", {})
    assert.equal(logout.status, 200, "unavailable push storage cannot prevent device logout")
    assert.deepEqual(fs.readFileSync(file), malformed)
  })
}

test("malformed persisted entry keeps storage unavailable and untouched", t => {
  const bytes = Buffer.from(JSON.stringify({
    v: 1, epoch: "", keys: { publicKey: "public", privateKey: "private-sentinel" },
    entries: [{ owner: "invalid-owner" }], routes: [],
  }))
  const { file } = storage(t, bytes)
  const push = new PushService({ file, enabled: () => true, authority: () => "active", projects: () => [] })
  t.after(() => push.close())
  assert.equal(push.status(principal).enabled, false)
  assert.equal(push.status(principal).subscribed, false)
  assert.throws(() => push.consent(principal), /storage unavailable/i)
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test("transient private storage read failures retry later without replacing malformed bytes", async t => {
  for (const code of ["EBUSY", "EPERM"]) await t.test(code, t => {
    const { file } = storage(t, malformed)
    const read = fs.readFileSync
    let blocked = true, reads = 0, now = Date.now()
    t.mock.method(Date, "now", () => now)
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) {
        reads++
        if (blocked) throw Object.assign(new Error("temporary read failure"), { code })
      }
      return read(...args)
    })
    const push = new PushService({ file, enabled: () => true, authority: () => "active", projects: () => [] })
    t.after(() => push.close())
    assert.equal(push.status(principal).enabled, false)
    assert.throws(() => push.consent(principal), /storage unavailable/i)
    assert.equal(reads, 1, "unavailable storage reads are bounded during the retry window")
    blocked = false
    now += 5001
    assert.equal(push.status(principal).enabled, false, "a successful read still rejects malformed JSON")
    assert.ok(reads > 1, "storage is reread after the retry window")
    assert.deepEqual(read(file), malformed)
    assert.throws(() => push.consent(principal), /storage unavailable/i)
    assert.deepEqual(read(file), malformed)
    // A host repair becomes usable on a later read, without restarting the service.
    const repaired = Buffer.from(JSON.stringify({ v: 1, epoch: "", keys: { publicKey: "public", privateKey: "private" }, entries: [], routes: [] }))
    fs.writeFileSync(file, repaired)
    now += 5001
    assert.equal(push.status(principal).enabled, true)
    assert.deepEqual(read(file), repaired, "read-only recovery preserves the host's repaired document")
  })
})
