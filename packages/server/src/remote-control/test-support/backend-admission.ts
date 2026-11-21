import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import { startFakeCodeNomad } from "../../codenomad-servers/test-support/fake-codenomad"
import { RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP } from "../../codenomad-servers/relay-authority"
import { resolveConfigLocation } from "../../config/location"
import { SettingsService } from "../../settings/service"

/** Saved destinations use the production relay and real sockets, with deliberately colliding raw IDs. */
export async function backendAdmissionFixture(t: TestContext, enabled = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-admission-"))
  const remotes = await Promise.all(["A", "B"].map(async label => {
    const remote = await startFakeCodeNomad({ anonymous: true })
    remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: label, apiContract: 1 } })
    remote.state.overrides.set("/api/workspaces", { status: 200, body: [{ id: "same-workspace", server: label }] })
    remote.state.overrides.set("/workspaces/same-workspace/instance/api/session/same-session", {
      status: 200, body: { id: "same-session", server: label },
      headers: { "set-cookie": "remote-cookie=private-cookie-sentinel", authorization: "Bearer private-auth-sentinel" },
    })
    return remote
  }))
  t.after(async () => {
    await Promise.all(remotes.map(remote => remote.close()))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const location = resolveConfigLocation(directory)
  const setEnabled = (value: unknown) => fs.writeFileSync(location.configYamlPath,
    `ui:\n  settings:\n    multiBackend: ${JSON.stringify(value)}\n`)
  setEnabled(enabled)
  const profiles = remotes.map((remote, index) => ({ id: index ? "B" : "A", baseUrl: remote.origin, skipTlsVerify: false }))
  fs.writeFileSync(location.stateYamlPath, JSON.stringify({ ui: { remoteServers: profiles, recentFolders: [] } }))
  const settings = new SettingsService(location, undefined, { child() { return this }, warn() {}, info() {} } as never)
  const io = () => remotes.reduce((total, remote) => total + remote.state.requests.length, 0)
  fs.mkdirSync(path.join(directory, ".ssh"))
  fs.writeFileSync(path.join(directory, ".ssh", "config"), "Host fixture-host\n  HostName 192.0.2.90\n")
  return { settings, remotes, io, setEnabled, directory }
}

export const backendAuthorityHeader = RELAY_AUTHORITY_HEADER
export const backendBootstrap = RELAY_BOOTSTRAP

export function assertServerCapabilities(meta: Record<string, unknown>, usable: boolean, secretEntryAllowed: boolean) {
  assert.equal(meta.serversUsable, usable)
  assert.equal(meta.serversManageable, usable)
  assert.equal(meta.secretEntryAllowed, secretEntryAllowed)
}

export function assertPrivateBackendReply(body: string, headers: Record<string, unknown>) {
  for (const sentinel of ["must-not-leak", "private-cookie-sentinel", "private-auth-sentinel"]) {
    assert.equal(`${body}${JSON.stringify(headers)}`.includes(sentinel), false, sentinel)
  }
  assert.equal(headers["set-cookie"], undefined)
  assert.equal(headers.authorization, undefined)
}
