import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import test from "node:test"
import { RemoteServerBrowseManager } from "./browse-manager"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { startRemoteSurface, FAKE_TUNNEL_HOST } from "../remote-control/test-support/surface"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"
import { SERVER_PAIR_PATH } from "../remote-control/server-pairing"

for (const change of ["address", "tls"] as const) {
  test(`R1 queued passwords retain their admitted destination and TLS authority: ${change}`, { timeout: 15_000 }, async t => {
    const first = await startFakeCodeNomad(), replacement = await startFakeCodeNomad()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr7-review-"))
    const profiles = [{ id: "saved", baseUrl: first.origin, skipTlsVerify: false }]
    const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
    const manager = new RemoteServerBrowseManager(settings)
    t.after(async () => { manager.close(); await first.close(); await replacement.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    first.state.handlers.set("/api/auth/status", () => started())
    const body = { username: "codenomad", password: "remote-password" }
    const active = manager.connect("saved", body).catch(() => undefined)
    await ready
    const queued = manager.connect("saved", body).catch(() => undefined)
    const queuedBrowse = manager.browse("saved", {}).catch(() => undefined)
    const requests = first.state.requests.length
    if (change === "address") profiles[0]!.baseUrl = replacement.origin
    else profiles[0]!.skipTlsVerify = true
    manager.reconcile()
    await Promise.all([active, queued, queuedBrowse])
    const leaked = replacement.state.requests.some(request => request.path === "/api/auth/login" && JSON.parse(request.body).password === body.password)
    assert.equal(leaked, false, "queued credentials were admitted for the original profile only")
    assert.equal(first.state.requests.length, requests, "a TLS change also revokes queued IO")
  })
}

test("R1 stored identity is bound to TLS policy across manager lifetimes", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr7-review-tls-"))
  const profiles = [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: true }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const first = new RemoteServerBrowseManager(settings)
  await first.connect("saved", { username: "codenomad", password: "remote-password" })
  first.close()
  profiles[0]!.skipTlsVerify = false
  const next = new RemoteServerBrowseManager(settings)
  t.after(async () => { next.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const requests = remote.state.requests.length
  await assert.rejects(next.browse("saved", {}), { code: "needs_credentials" })
  assert(remote.state.requests.slice(requests).every(request => !request.headers.cookie && !request.body))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
})

test("R2 forget revokes every listener's shared connection and credential cache", { timeout: 15_000 }, async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr7-review-shared-"))
  const settings = { getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: false }] }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const a = new RemoteServerBrowseManager(settings), b = new RemoteServerBrowseManager(settings)
  t.after(async () => { a.close(); b.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await a.connect("saved", { username: "codenomad", password: "remote-password" })
  let response: http.ServerResponse | undefined
  remote.state.handlers.set("/api/test/live", (_request, reply) => { response = reply; reply.writeHead(200, { "content-type": "text/event-stream" }); reply.write("data: before\n\n") })
  const stream = await b.relay("saved", "/api/test/live", {})
  const reader = stream.body!.getReader()
  await reader.read()
  await a.forget("saved")
  response!.write("data: after-forget\n\n")
  const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
  const live = !chunk.done && Buffer.from(chunk.value!).toString().includes("after-forget")
  assert.equal(live, false, "forget on one listener must close the other listener stream")
  await assert.rejects(b.relay("saved", "/api/filesystem", {}), { code: "needs_credentials" })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
})

test("R1 a failed replacement under another TLS policy cannot retain the disk identity", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr7-review-policy-"))
  const profiles = [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: true }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const first = new RemoteServerBrowseManager(settings)
  await first.connect("saved", { username: "codenomad", password: "remote-password" })
  first.close()
  profiles[0]!.skipTlsVerify = false
  const next = new RemoteServerBrowseManager(settings)
  t.after(async () => { next.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(next.connect("saved", { username: "codenomad", password: "wrong" }), { code: "auth" })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
})

function send(target: string, url: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request(`http://${target}${url}`, { method: body ? "POST" : "GET", headers }, response => {
      response.resume()
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers }))
    })
    request.on("error", reject)
    request.end(body ? JSON.stringify(body) : undefined)
  })
}

test("R2 closing one listener preserves the other listener's connection owner and credential rotation", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr7-review-close-"))
  const settings = { getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin }] }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const a = new RemoteServerBrowseManager(settings), b = new RemoteServerBrowseManager(settings)
  t.after(async () => { a.close(); b.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await a.connect("saved", { username: "codenomad", password: "remote-password" })
  await a.browse("saved", {})
  a.close()
  a.close()
  await assert.rejects(a.forget("saved"), { code: "unreachable" })
  remote.restart()
  assert.equal((await b.browse("saved", {})).listing.metadata.currentPath, "/srv/projects")
  assert.equal(remote.state.logins, 2)
  remote.state.handlers.set("/api/live", (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: open\n\n") })
  const response = await b.relay("saved", "/api/live", {})
  const reader = response.body!.getReader()
  await reader.read()
  b.close()
  await assert.rejects(reader.read())
})

test("R3 browser pairing remains ingress-only with a valid device and public browser Origin", { timeout: 15_000 }, async t => {
  const f = await startRemoteSurface(t)
  // Use the ordinary exchange to obtain a device, then retain the reviewer's direct-listener request.
  const paired = await new Promise<string>((resolve, reject) => {
    const request = http.request(`http://${f.target()}${SERVER_PAIR_PATH}`, { method: "POST", headers: { host: FAKE_TUNNEL_HOST, "x-codenomad-server-pairing": "1", "content-type": "application/json" } }, response => {
      let body = ""
      response.on("data", chunk => { body += chunk })
      response.on("end", () => { assert.equal(response.statusCode, 200); resolve(JSON.parse(body).credential) })
    })
    request.on("error", reject)
    request.end(JSON.stringify({ code: f.code, hostName: "review" }))
  })
  const next = f.manager.createPairing()
  const result = await send(f.local, "/api/remote-control/pair", { cookie: `${DEVICE_COOKIE_NAME}=${paired}`, "x-codenomad-server-request": "1", origin: `https://${FAKE_TUNNEL_HOST}`, "content-type": "application/json" }, { code: new URL(next.url).hash.slice(1), name: "second" })
  assert.equal(result.status, 404, "direct listener must not inherit ingress-only browser pairing")
  assert.equal(result.headers["set-cookie"], undefined)
})
