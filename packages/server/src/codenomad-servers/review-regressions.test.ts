import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ServerResponse } from "node:http"
import test from "node:test"
import { RemoteServerBrowseManager } from "./browse-manager"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import { CodeNomadServerCredentials } from "./credentials"

for (const change of ["address", "tls"] as const) {
  test(`R1 queued passwords retain their admitted destination and TLS authority: ${change}`, { timeout: 15_000 }, async t => {
    const first = await startFakeCodeNomad(), replacement = await startFakeCodeNomad()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-"))
    const profiles = [{ id: "saved", baseUrl: first.origin, skipTlsVerify: false }]
    const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
    const manager = new RemoteServerBrowseManager(settings)
    t.after(async () => { manager.close(); await first.close(); await replacement.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    let started!: () => void
    let reply!: ServerResponse
    const ready = new Promise<void>(resolve => { started = resolve })
    first.state.handlers.set("/api/auth/status", (_request, response) => {
      first.state.handlers.delete("/api/auth/status")
      reply = response
      started()
      // Release the old authentication result after the profile changes.
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"authenticated":')
    })
    const body = { username: "codenomad", password: "remote-password" }
    const active = manager.connect("saved", body).catch(() => undefined)
    await ready
    const queued = manager.connect("saved", body).catch(() => undefined)
    const queuedBrowse = manager.browse("saved", {}).catch(() => undefined)
    const requests = first.state.requests.length
    if (change === "address") profiles[0]!.baseUrl = replacement.origin
    else profiles[0]!.skipTlsVerify = true
    manager.reconcile?.()
    reply.end("true}")
    await Promise.all([active, queued, queuedBrowse])
    const leaked = replacement.state.requests.some(request => request.path === "/api/auth/login" && JSON.parse(request.body).password === body.password)
    assert.equal(leaked, false, "queued credentials were admitted for the original profile only")
    assert.equal(first.state.requests.length, requests, "a TLS change also revokes queued IO")
  })
}

test("R1 stored identity is bound to TLS policy across manager lifetimes", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-tls-"))
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

test("R1 a failed replacement under another TLS policy cannot retain the disk identity", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-policy-"))
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

test("R1 persisted entries without a TLS field bind to verified TLS", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-legacy-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "credentials.json")
  const secret = { kind: "session" as const, cookie: "session=test" }
  fs.writeFileSync(file, JSON.stringify({ servers: { saved: { origin: "https://remote.test", secret } } }))
  const store = new CodeNomadServerCredentials(file)
  assert.deepEqual(store.read("saved", "https://remote.test", false), secret)
  assert.equal(store.read("saved", "https://remote.test", true), undefined)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { servers: {} })
})

test("R2 forget revokes every listener's active browse and shared credential cache", { timeout: 15_000 }, async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-shared-"))
  const settings = { getOwner: () => ({ remoteServers: [{ id: "saved", baseUrl: remote.origin, skipTlsVerify: false }] }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const a = new RemoteServerBrowseManager(settings), b = new RemoteServerBrowseManager(settings)
  t.after(async () => { a.close(); b.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await a.connect("saved", { username: "codenomad", password: "remote-password" })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  remote.state.handlers.set("/api/filesystem", (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"entries":[')
    started()
  })
  const active = b.browse("saved", {}).then(() => false, () => true)
  await ready
  await a.forget("saved")
  // A revoked body must fail without waiting for the 10-second upstream timeout.
  const cancelled = await Promise.race([active, new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 1000)
    void active.finally(() => clearTimeout(timer))
  })])
  assert.equal(cancelled, true, "forget on one listener must abort the other listener body")
  remote.state.handlers.delete("/api/filesystem")
  await assert.rejects(b.browse("saved", {}), { code: "needs_credentials" })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "remote-server-credentials.json"), "utf8")), { servers: {} })
})

test("R2 closing one listener preserves the other listener's connection owner and credential rotation", async t => {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-review-close-"))
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
})
