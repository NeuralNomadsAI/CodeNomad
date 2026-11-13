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

test("SSH relay proofs bind the tunnel destination and reject stale generations before dispatch", async t => {
  const f = await fixture(t)
  await f.login()
  f.remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: "ssh-server" } })
  const metadata = await f.manager.relay("saved", "/api/meta", {}, RELAY_BOOTSTRAP)
  const proof = metadata.headers.get(RELAY_AUTHORITY_HEADER)
  assert.ok(proof)
  assert.equal((await f.manager.relay("saved", "/api/auth/status", {}, proof)).status, 200)
  const dispatched = f.remote.state.requests.length
  f.profiles[0]!.ssh.host = "replacement"
  f.manager.reconcile()
  assert.equal(f.forwards[0]!.closed, true)
  await assert.rejects(f.manager.relay("saved", "/api/auth/status", {}, proof), { code: "unreachable" })
  assert.equal(f.remote.state.requests.length, dispatched)
  assert.equal(f.forwards.length, 1)
})
