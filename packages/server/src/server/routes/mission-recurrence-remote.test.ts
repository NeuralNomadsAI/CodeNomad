import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import { recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"
import { attachRemoteDevice, markRemoteSocket } from "../../remote-control/request-origin"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { registerMissionRecurrenceCreate } from "./mission-recurrence-create"
import { verifyHumanRecurrenceRequest } from "./mission-recurrence-proof"

// Every request through this app arrives on the Remote Control ingress for `device`.
function remoteIngress(app: FastifyInstance, device: string) {
  app.addHook("onRequest", (request, _reply, done) => {
    markRemoteSocket(request.raw.socket); attachRemoteDevice(request, device); done()
  })
}

test("recurring controls admit a local login and a live paired device; an unqualified device is refused before any hold", async () => {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-remote-"))
  const local = Fastify({ logger: false }), remote = Fastify({ logger: false }), stranger = Fastify({ logger: false })
  remoteIngress(remote, "device-1"); remoteIngress(stranger, "device-2")
  try {
    execFileSync("git", ["init", "-q", base])
    const directory = realpathSync(base), yaml = path.join(base, "selected.yml")
    await writeFile(yaml, "server: {}\n")
    const selected = canonicalScope("stable", yaml, base, base)
    const auth = new AuthManager({ configPath: base, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
    const human = auth.createSession("human"), workspace = {}, location = { directory }
    let authorized = true, revision = 0
    const remoteDevices = { isDeviceAuthorized: (id: string) => id === "device-1" && authorized }
    const committed = new Map<string, { state: string }>()
    const controls: string[] = []
    const settings = { configYamlPathForAuthority: () => yaml, getProfileScope: () => selected }
    const manager = { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
      getSharedServiceConnection: async () => connection, ownsLocation: async () => true,
      getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory }
    // The native plugin verifies through the private bridge callback before any store write.
    const client = { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) },
      rpc: () => ({ recurrenceControl: async (input: Record<string, unknown> & { sessionID: string; requestID: string; action: string }) => {
        const { proof: _proof, retry: _retry, ...body } = input
        await verifyHumanRecurrenceRequest(body, { auth, manager: manager as never, settings, remoteDevices }, new AbortController().signal)
        controls.push(input.sessionID)
        committed.set(input.requestID, { state: input.action === "play" ? "running" : "paused" })
        return { requestID: input.requestID, scheduleID: "daily_review", revision: ++revision, controlsComplete: true }
      }, recurrenceControlStatus: async (input: { requestID: string; expectedRevision: number }) => {
        const record = committed.get(input.requestID)
        return record ? { version: 1, scheduleID: "daily_review", requestID: input.requestID, expectedRevision: input.expectedRevision,
          outcome: "committed", state: record.state, revision: input.expectedRevision + 1, controlsComplete: true }
          : { version: 1, scheduleID: "daily_review", requestID: input.requestID, expectedRevision: input.expectedRevision, outcome: "unknown" }
      } }) }
    const connection = { client, assertCurrent: () => {} }
    const fence = new WorktreeDeletionFence()
    for (const app of [local, remote, stranger]) {
      registerMissionRecurrenceControl(app, { auth, bridgeToken: "existing-bridge-token", fence, settings, remoteDevices, manager } as never)
    }
    const url = "/api/workspaces/owned/missions/recurrence/daily_review/control"
    const send = (app: FastifyInstance, action: string, requestID: string, cookie = false) => app.inject({ method: "POST", url,
      payload: { action, expectedRevision: revision, requestID }, headers: cookie ? { cookie: `${auth.getCookieName()}=${human.id}` } : {} })

    // Local login: unchanged.
    assert.equal((await send(local, "play", "local_unauthenticated")).statusCode, 401)
    const played = await send(local, "play", "local_play", true)
    assert.equal(played.statusCode, 200)
    assert.equal(played.json().requestID, "local_play")

    // A paired device that is still authorized verifies as its own principal.
    const paused = await send(remote, "pause", "remote_pause")
    assert.equal(paused.statusCode, 200)
    assert.deepEqual(controls, [human.id, "remote-device:device-1"])
    assert(!paused.body.includes(human.id))

    // A local login cookie forwarded through the tunnel never turns the device into a cookie principal.
    authorized = false
    for (const [app, requestID] of [[remote, "revoked_play"], [stranger, "unpaired_play"]] as const) {
      const refused = await app.inject({ method: "POST", url, payload: { action: "play", expectedRevision: revision, requestID },
        headers: { cookie: `${auth.getCookieName()}=${human.id}` } })
      assert.equal(refused.statusCode, 401, "refused definitively, never left uncertain")
    }
    assert.equal(controls.length, 2, "nothing was dispatched for the refused devices")

    // No hold survives the refusals: the schedule and its checkout stay usable.
    const resumed = await send(local, "play", "local_after_refusal", true)
    assert.equal(resumed.statusCode, 200)
    const release = fence.enter([canonicalWorktreeIdentity(directory)])
    assert(release, "the checkout's deletion fence is free")
    release()
  } finally {
    await Promise.all([local.close(), remote.close(), stranger.close()])
    await rm(base, { recursive: true, force: true })
  }
})

test("recurring Create refuses an unqualified device before any native read and admits a live paired device", async () => {
  let authorized = false, connections = 0
  const app = Fastify({ logger: false })
  remoteIngress(app, "device-1")
  const manager = { get: () => undefined, getServiceLocation: () => undefined,
    getSharedServiceConnection: async () => { connections++; return undefined } }
  const auth = { isAuthEnabled: () => true, getSessionFromRequest: () => ({ username: "human", sessionId: "remote-device:device-1" }) }
  registerMissionRecurrenceCreate(app, { workspaceManager: manager as never, auth, bridgeToken: "token",
    remoteDevices: { isDeviceAuthorized: (id: string) => id === "device-1" && authorized }, worktreeDeletionFence: new WorktreeDeletionFence() })
  try {
    const payload = { template: "custom", requestID: "remote_schedule", instructions: "Review", clock: { time: "09:30", zone: "UTC" },
      watchedConversationIDs: [], profiles: { coordinator: { agent: "a", model: { providerID: "p", id: "m" } }, roles: { specialist: { agent: "b", model: { providerID: "p", id: "m" } } } },
      taskMode: "native" }
    const post = () => app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/recurrence", payload })
    assert.equal((await post()).statusCode, 401)
    assert.equal(connections, 0)
    authorized = true
    // Admitted past human authentication; this fixture has no workspace, so it stops there with a definitive 404.
    assert.equal((await post()).statusCode, 404)
  } finally { await app.close() }
})

test("the bridge verifier keeps device and cookie principals apart and follows live device authorization", async () => {
  const identity = { sessionID: "remote-device:device-1", workspaceID: "workspace", requestID: "remote_create",
    location: { directory: "/owned" }, scheduleID: "daily_review", action: "create" as const, expectedRevision: 0,
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/selected/config.yaml" }, issuedAt: Date.now() }
  const sign = (value: typeof identity) => ({ ...value, digest: recurrenceControlRequestDigest(value) })
  let authorized = true
  const workspace = {}
  const deps = (devices: boolean) => ({ settings: { getProfileScope: () => ({ key: "profile" }) },
    auth: { isAuthEnabled: () => true, getCookieName: () => "cookie",
      // Even a cookie lookup that would accept anything cannot admit a device-named principal.
      getSessionFromHeaders: () => ({ username: "human", sessionId: "remote-device:device-1" }) },
    ...(devices ? { remoteDevices: { isDeviceAuthorized: (id: string) => id === "device-1" && authorized } } : {}),
    manager: { getServiceWslDistro: () => undefined, get: () => workspace, ownsLocation: async () => true,
      getSharedServiceConnection: async () => ({ assertCurrent: () => {}, client: { location: { get: async () => ({ directory: "/owned" }) } } }) } })
  const verify = (value = identity, devices = true) => verifyHumanRecurrenceRequest(sign(value), deps(devices) as never, new AbortController().signal)
  assert.deepEqual(await verify(), { admitted: true })
  await assert.rejects(verify(identity, false), "no live registry, no device principal")
  await assert.rejects(verify({ ...identity, sessionID: "remote-device:device-2" }))
  await assert.rejects(verify({ ...identity, sessionID: "remote-device:" }))
  authorized = false
  await assert.rejects(verify(), "a revoked device no longer qualifies")
})
