import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { RemoteServerBrowseManager } from "./browse-manager"
import { ExplicitEndpointError } from "../opencode/servers/endpoint"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"
import type { openSshForward } from "./ssh"
import { RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP } from "./relay-authority"

async function fixture(t: TestContext) {
  const remote = await startFakeCodeNomad()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-manager-"))
  const profiles = [{ id: "saved", baseUrl: "http://remote.invalid:9898", ssh: { host: "lab" } }]
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml") }
  const forwards: { host: string; target: string; closed: boolean; die(): void }[] = []
  let failure = false
  const open: typeof openSshForward = (host, target, options) => {
    const entry = { host, target, closed: false, die() { options?.onExit?.() } }
    forwards.push(entry)
    return { ready: failure ? Promise.reject(new ExplicitEndpointError("ssh_auth")) : Promise.resolve(Number(new URL(remote.origin).port)),
      close() { entry.closed = true; entry.die() } }
  }
  const manager = new RemoteServerBrowseManager(settings, open)
  t.after(async () => { manager.close(); await remote.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const login = () => manager.connect("saved", { username: "codenomad", password: "remote-password" })
  const request = async (owner = manager) => {
    const response = await owner.relay("saved", "/api/auth/status", {})
    return response.json() as Promise<{ authenticated: boolean }>
  }
  return { remote, profiles, settings, forwards, manager, open, login, request, fail: () => { failure = true } }
}

test("SSH relay coalesces a tunnel and retains origin and credentials across child death", async t => {
  const f = await fixture(t)
  await f.login()
  assert.deepEqual(await Promise.all([f.request(), f.request()]), [{ authenticated: true }, { authenticated: true }])
  assert.equal(f.forwards.length, 1)
  assert.equal(f.forwards[0]!.target, "remote.invalid:9898")
  assert.equal(f.remote.state.requests.at(-1)!.headers.host, "remote.invalid:9898")
  f.forwards[0]!.die()
  assert.equal((await f.request()).authenticated, true)
  assert.equal(f.forwards.length, 2)
  assert.equal(f.remote.state.logins, 1)
})

test("SSH host retargeting revokes credentials and the old tunnel", async t => {
  const f = await fixture(t)
  await f.login()
  f.profiles[0]!.ssh.host = "other"
  f.manager.reconcile()
  assert.equal(f.forwards[0]!.closed, true)
  assert.equal((await f.request()).authenticated, false)
  assert.equal(f.remote.state.requests.at(-1)!.headers.cookie, undefined)
  assert.equal(f.forwards[1]!.host, "other")
  assert.equal(f.remote.state.logins, 1)
})

test("SSH auth observation restores privately without replay and fences retargeted proof before IO", async t => {
  const f = await fixture(t)
  await f.login()
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "ssh-server" } })
  const metadata = await f.manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)
  const proof = metadata.headers.get(RELAY_AUTHORITY_HEADER)!
  assert.ok(proof)
  f.remote.restart()
  const response = await f.manager.relay("saved", "/api/filesystem", {}, proof)
  assert.equal(response.status, 401)
  await response.body?.cancel()
  assert.equal(f.remote.state.requests.filter(request => request.path === "/api/filesystem").length, 1)
  assert.equal(f.remote.state.logins, 2)
  assert.deepEqual(await (await f.manager.relay("saved", "/api/auth/status", {}, proof)).json(), { authenticated: true })
  assert.equal(f.forwards.length, 1)
  f.profiles[0]!.ssh.host = "replacement"
  f.manager.reconcile()
  const before = f.remote.state.requests.length
  await assert.rejects(f.manager.relay("saved", "/api/auth/status", {}, proof), { code: "unreachable" })
  assert.equal(f.remote.state.requests.length, before)
  assert.equal(f.forwards.length, 1)
  assert.equal(f.forwards[0]!.closed, true)
})

test("SSH failure never falls back to the profile's local loopback address", async t => {
  const f = await fixture(t)
  f.profiles[0]!.baseUrl = f.remote.origin
  f.fail()
  await assert.rejects(f.login(), { code: "ssh_auth" })
  assert.equal(f.remote.state.requests.length, 0)
})

test("shared SSH owner survives one listener closing; forget and final shutdown close tunnels", async t => {
  const f = await fixture(t)
  const second = new RemoteServerBrowseManager(f.settings, f.open)
  t.after(() => second.close())
  await f.login()
  await f.request()
  f.manager.close()
  assert.equal(f.forwards[0]!.closed, false)
  assert.equal((await f.request(second)).authenticated, true)
  await second.forget("saved")
  assert.equal(f.forwards[0]!.closed, true)
  await second.connect("saved", { username: "codenomad", password: "remote-password" })
  second.close()
  assert.equal(f.forwards[1]!.closed, true)
})

test("SSH proof binds the declared origin and survives forward renewal and same-principal login", async t => {
  const f = await fixture(t)
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "ssh-server" } })
  await f.login()
  const metadata = () => f.manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)
  const proof = (await metadata()).headers.get(RELAY_AUTHORITY_HEADER)!
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(f.manager.assertProof("saved", proof).origin, f.profiles[0]!.baseUrl)
  await f.login()
  assert.equal((await metadata()).headers.get(RELAY_AUTHORITY_HEADER), proof)
  f.forwards[0]!.die()
  const response = await f.manager.relay("saved", "/api/auth/status", {}, proof)
  assert.deepEqual(await response.json(), { authenticated: true })
  assert.equal(f.forwards.length, 2)
  assert.equal((await metadata()).headers.get(RELAY_AUTHORITY_HEADER), proof)
  assert.equal(f.remote.state.requests.at(-1)!.headers.host, "remote.invalid:9898")
})

test("SSH retargeting revokes proof before opening a forward or dispatching", async t => {
  const f = await fixture(t)
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "ssh-server" } })
  await f.login()
  const proof = (await f.manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(RELAY_AUTHORITY_HEADER)!
  const requests = f.remote.state.requests.length
  f.profiles[0]!.ssh.host = "other"
  await assert.rejects(f.manager.relay("saved", "/api/filesystem", {}, proof), { code: "unreachable" })
  assert.equal(f.forwards[0]!.closed, true)
  assert.equal(f.forwards.length, 1)
  assert.equal(f.remote.state.requests.length, requests)
})

test("changed remote identity through an SSH forward revokes proof and closes the owned tunnel", async t => {
  const f = await fixture(t)
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "ssh-server" } })
  await f.login()
  const proof = (await f.manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(RELAY_AUTHORITY_HEADER)!
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "replacement" } })
  await assert.rejects(f.manager.relay("saved", "/api/meta", {}, proof), { code: "unknown_server" })
  assert.equal(f.forwards[0]!.closed, true)
  const requests = f.remote.state.requests.length
  await assert.rejects(f.manager.relay("saved", "/api/filesystem", {}, proof), { code: "unreachable" })
  assert.equal(f.remote.state.requests.length, requests)
  assert.equal(f.forwards.length, 1)
})

for (const identity of ["A", "B", "missing", "refused"] as const) for (const operation of ["mutation", "status", "observation"] as const) {
  test(`SSH renewal checks identity once before concurrent ${operation}: ${identity}`, async t => {
    const a = await startFakeCodeNomad({ anonymous: true }), b = await startFakeCodeNomad({ anonymous: true })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-renewal-"))
    const profiles = [{ id: "saved", baseUrl: "http://remote.invalid:9898", ssh: { host: "lab" } }]
    const forwards: { closed: boolean; die(): void }[] = []
    let destination = a
    const manager = new RemoteServerBrowseManager({
      getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(dir, "config.yaml"),
    }, (_host, _target, options) => {
      const entry = { closed: false, die() { options?.onExit?.() } }
      forwards.push(entry)
      return { ready: Promise.resolve(Number(new URL(destination.origin).port)), close() { entry.closed = true; entry.die() } }
    })
    t.after(async () => { manager.close(); await a.close(); await b.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    a.state.overrides.set("/api/meta", { status: 200, body: { serverId: "A" } })
    b.state.overrides.set("/api/meta", { status: identity === "refused" ? 503 : 200,
      body: identity === "missing" ? {} : { serverId: identity } })
    b.state.overrides.set("/api/workspaces", { status: 200, body: {} })
    const proof = (await manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(RELAY_AUTHORITY_HEADER)!
    if (operation === "observation") {
      a.state.handlers.set("/api/workspaces", (_request, response) => {
        forwards[0]!.die()
        destination = b
        response.writeHead(401); response.end("business-401")
      })
    } else {
      forwards[0]!.die()
      destination = b
    }
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      manager.relay("saved", operation === "status" ? "/api/auth/status" : "/api/workspaces",
        operation === "mutation" ? { method: "POST", body: "{}" } : {}, proof)))
    assert.equal(b.state.requests.filter(request => request.path === "/api/workspaces").length, identity === "A" && operation === "mutation" ? 5 : 0)
    assert.equal(b.state.requests.filter(request => request.path === "/api/auth/status").length,
      identity === "A" && operation !== "mutation" ? 1 : 0)
    assert.equal(results.every(result => result.status === (identity === "A" ? "fulfilled" : "rejected")), true)
    assert.equal(b.state.requests.filter(request => request.path === "/api/meta").length, 1)
    if (identity === "A") {
      assert.equal(manager.assertProof("saved", proof).proof, proof)
      assert.equal(forwards[1]!.closed, false)
      for (const result of results) if (result.status === "fulfilled") {
        assert.equal(result.value.status, operation === "observation" ? 401 : 200)
        await result.value.body?.cancel()
      }
    } else {
      assert.throws(() => manager.assertProof("saved", proof))
      assert.equal(forwards[1]!.closed, true)
    }
  })
}
