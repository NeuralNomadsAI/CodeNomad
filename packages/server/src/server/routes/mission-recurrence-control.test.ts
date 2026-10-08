import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { recurrenceHumanRequestID } from "../../missions/recurrence-authority-contract"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"

test("auth-disabled sessions cannot Play; missing native graph never activates due work", async () => {
  assert.equal("recurrenceControl" in CODENOMAD_MISSIONS_RPC.methods, true)
  const app = Fastify({ logger: false })
  let enabled = false
  registerMissionRecurrenceControl(app, { auth: {
    isAuthEnabled: () => enabled,
    getSessionFromRequest: () => enabled ? { sessionId: "real-cookie", username: "human" }
      : { sessionId: "auth-disabled", username: "human" },
  } } as never)
  try {
    const send = () => app.inject({ method: "POST", url: "/api/workspaces/owned/missions/recurrence/daily_review/control",
      payload: { action: "play", expectedRevision: 0, expectedEpoch: 0,
        requestID: recurrenceHumanRequestID("daily_review", 1, "authorize") } })
    assert.equal((await send()).statusCode, 401)
    enabled = true
    assert.equal((await send()).statusCode, 503)
  } finally { await app.close() }
})

test("real cookie human Play uses exact selected YAML; lost ACK performs one receipt read and never a second control", async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "http-play-offline-"))
  const app = Fastify({ logger: false })
  try {
    execFileSync("git", ["init", "-q", base])
    const directory = realpathSync(base), yaml = path.join(base, "selected.yml")
    await writeFile(yaml, "server: {}\n")
    const selected = canonicalScope("stable", yaml, base, base)
    const auth = new AuthManager({ configPath: base, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
    const human = auth.createSession("human"), workspace = {}, location = { directory }
    let controlCalls = 0, reads = 0
    const requestID = recurrenceHumanRequestID("daily_review", 1, "authorize")
    const client = { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) },
      rpc: () => ({ recurrenceControl: async (input: { sessionID: string; requestID: string; expectedEpoch: number; profileSource: { configYamlPath: string } }) => {
        controlCalls++
        assert.equal(input.sessionID, human.id)
        assert.equal(input.requestID, requestID)
        assert.equal(input.expectedEpoch, 0)
        assert.equal(input.profileSource.configYamlPath, yaml)
        throw new Error("Lost native acknowledgement")
      }, recurrenceControlStatus: async (input: { requestID: string; expectedRevision: number }) => {
        reads++
        assert.equal(input.requestID, requestID)
        return { version: 1, scheduleID: "daily_review", requestID, expectedRevision: 0,
          epoch: 1, outcome: "committed", state: "running", revision: 1, controlsComplete: true }
      } }) }
    registerMissionRecurrenceControl(app, { auth, bridgeToken: "existing-bridge-token", fence: new WorktreeDeletionFence(),
      settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => selected },
      manager: { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
        getSharedServiceConnection: async () => ({ client, assertCurrent: () => {} }), ownsLocation: async () => true,
        getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
        getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory } } as never)
    const url = "/api/workspaces/owned/missions/recurrence/daily_review/control"
    const payload = { action: "play", expectedRevision: 0, expectedEpoch: 0, requestID }
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401)
    const response = await app.inject({ method: "POST", url, payload, headers: { cookie: `${auth.getCookieName()}=${human.id}` } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().outcome, "committed")
    assert.deepEqual([controlCalls, reads], [1, 1])
    assert(!response.body.includes(human.id))
    assert(!response.body.includes(yaml))
  } finally { await app.close(); await rm(base, { recursive: true, force: true }) }
})
