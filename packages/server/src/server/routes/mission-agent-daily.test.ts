import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import Fastify from "fastify"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { recurrenceConfigDigest } from "../../opencode/missions/native-recurrence-create"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { canonicalScope } from "../../host-lifetime/protocol"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { resolveRecurrenceRoot } from "./mission-recurrence-roots"
import { verifyRecurrenceRequest } from "./mission-recurrence-proof"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { controlAgentMissionSchedule } from "./mission-agent-schedule"
import { scheduleToolInput } from "../../missions/schedule-tool"
import type { MissionJsonValue } from "../../missions/model"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"

async function fixture(t: test.TestContext, sibling = false) {
  const scratch = await mkdtemp(path.join(tmpdir(), "opencode", "agent-daily-"))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  execFileSync("git", ["init", "-q", scratch])
  if (sibling) {
    execFileSync("git", ["-C", scratch, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture"])
    execFileSync("git", ["-C", scratch, "worktree", "add", "-qb", "sibling", path.join(scratch, "sibling")])
  }
  const directory = await realpath(scratch), yaml = path.join(directory, "profile.yaml")
  const callerDirectory = sibling ? await realpath(path.join(scratch, "sibling")) : directory
  await writeFile(yaml, "server: {}\n")
  const scope = canonicalScope("stable", yaml, directory, directory), workspace = { id: "owned" }
  const settings = { getProfileScope: () => scope, configYamlPathForAuthority: () => yaml }
  const values = new Map<string, MissionJsonValue>(), calls: any[] = []
  const storage = { get: async (key: string) => values.get(key), set: async (key: string, value: MissionJsonValue) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) }
  const store = new NativeMissionRecurrenceStore(storage, "project", directory), current = () => true as const
  const state = { loseACK: false, unknown: false, owned: true, effects: 0, foreignTarget: false, unreadableSnapshot: false }
  const manuals = new Map<string, any>()
  const receipt = async (input: any) => {
    const doc = await store.read(input.scheduleID), record = doc?.controls.find(row => row.requestID === input.requestID)
    if (!record || state.unknown) return { version: 1, scheduleID: input.scheduleID, requestID: input.requestID,
      expectedRevision: input.expectedRevision, outcome: "unknown" }
    const { targetsKnown: _known, ...rest } = record
    return { version: 1, scheduleID: doc!.id, ...rest, outcome: record.controlsComplete ? "committed" : "unknown" }
  }
  const auth = { isAuthEnabled: () => true, getCookieName: () => "cookie",
    getSessionFromRequest: () => ({ sessionId: "human_cookie", username: "human" }),
    getSessionFromHeaders: () => assert.fail("Agent never authenticates with a fabricated human cookie") }
  const verify = async (input: any) => {
    const { proof, retry: _retry, ...body } = input
    assert.equal(proof, signNativeRecurrenceControl(body, "private"))
    assert.equal(body.digest, recurrenceControlRequestDigest((({ digest: _digest, ...identity }) => identity)(body)))
    assert.equal(body.principal.kind, "agent")
    assert.equal(body.principal.author.coordinatorSessionID, "ses_child")
    await verifyRecurrenceRequest(body, { auth, manager, settings } as never, new AbortController().signal)
  }
  const rpc = {
    recurrenceList: async ({ after, limit }: any) => {
      const rows = (await store.list()).filter(doc => !after || doc.id > after), selected = rows.slice(0, limit)
      return { projectID: "project", projectCanonical: directory, schedules: selected.map(doc => ({ id: doc.id, directory: doc.config.roots[0].directory })),
        ...(rows.length > selected.length ? { next: selected.at(-1)!.id } : {}) }
    },
    recurrenceRead: async ({ id }: any) => { const doc = await store.read(id); return { schedule: doc ? {
      id, revision: doc.revision, state: doc.state, digest: recurrenceConfigDigest(doc.config), projectID: "project", projectCanonical: directory,
      directory: doc.config.roots[0].directory } : null } },
    recurrenceCreate: async (input: any) => {
      await verify(input.transport); calls.push(input)
      const doc = await store.create(input.id, input.config, Date.now(), current)
      if (state.loseACK) throw new Error("Lost ACK")
      return rpc.recurrenceRead({ id: doc.id })
    },
    recurrenceControl: async (input: any) => {
      await verify(input); calls.push(input)
      const before = await store.read(input.scheduleID), previous = before?.controls.find(row => row.requestID === input.requestID)
      const doc = await store.beginControl(input.scheduleID, input, current, input.profileSource)
      if (!previous?.controlsComplete) {
        state.effects++
        await store.recordControl(doc.id, { ...doc.controls.find(row => row.requestID === input.requestID)!,
          controlsComplete: true, targetsKnown: true }, current)
      }
      if (state.loseACK) throw new Error("Lost ACK")
      const { outcome: _outcome, ...result } = await receipt(input)
      return result
    },
    recurrenceControlStatus: receipt,
    recurrenceRunNow: async (input: any) => {
      await verify(input); calls.push(input)
      if (manuals.has(input.requestID)) return manuals.get(input.requestID)
      const doc = await store.reserveManual(input.scheduleID, input.requestID, input.expectedRevision, Date.now(), input.profileSource, current)
      const passage = doc.pending!.passage
      const admission = { kind: "accepted" as const, passageID: passage.id, messageID: passage.messageID,
        missionID: "msn_manual", conversationID: passage.coordinatorSessionID }
      await store.recordAdmission(doc.id, admission, Date.now(), current)
      state.effects++
      const result = { version: 1, scheduleID: doc.id, requestID: input.requestID, expectedRevision: input.expectedRevision,
        projectID: "project", projectCanonical: directory, location: { directory }, outcome: "accepted", passageID: passage.id,
        messageID: passage.messageID, admission }
      manuals.set(input.requestID, result)
      return result
    },
    recurrenceSnapshot: async ({ scheduleID }: any, options: any) => {
      if (state.unreadableSnapshot) throw new Error("Display clock unavailable")
      return { version: 1, projectID: "project", projectCanonical: directory, location: options.location,
      schedules: (await store.list()).filter(doc => doc.config.roots[0].directory === options.location.directory && (!scheduleID || doc.id === scheduleID))
      .map(doc => ({ id: doc.id, title: doc.config.title, revision: doc.revision, state: doc.state,
        clock: doc.config.clock, nextDueAt: doc.state === "running" ? Date.now() + 60_000 : null, pending: null, latestResult: null, history: [],
        actions: ["play", "pause", "stop", "resume", "run-now", "check"], controls: [] })) }
    },
  }
  const profile = { agent: "build", model: { providerID: "test", id: "model" } }
  const client = {
    location: { get: async ({ location }: any) => ({ ...location, project: {
      id: state.foreignTarget && location.directory === directory ? "foreign" : "project", canonical: directory } }) },
    session: { get: async ({ sessionID }: any) => ({ id: sessionID, parentID: "ses_root", projectID: "project", location: { directory: callerDirectory } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    agent: { list: async () => ({ data: [{ id: "build", mode: "all" }] }) },
    model: { list: async () => ({ data: [{ ...profile.model, enabled: true, capabilities: { tools: true }, variants: [] }] }) },
    rpc: () => rpc,
  }
  const connection = { client, assertCurrent() {} }
  const manager = { list: () => [workspace], get: () => workspace, getServiceLocation: () => ({ directory }),
    getSharedServiceConnection: async () => connection, ownsLocation: async () => state.owned,
    getServiceDirectoryForPath: async (_id: string, path: string) => path, getWorktreeIdentityForPath: async (_id: string, path: string) => canonicalWorktreeIdentity(path),
    getHostPathForServicePath: async (_id: string, path: string) => path, getServiceWslDistro: () => undefined,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix" }
  const roots = [await resolveRecurrenceRoot(manager as never, workspace.id, directory, directory, undefined)]
  const creation = { instructions: "Daily fixture", clock: { time: "09:30", zone: "UTC" }, template: "custom",
    taskMode: "native", profiles: { coordinator: profile, roles: { specialist: profile } }, watchedConversationIDs: [] }
  await store.create("daily_human", { title: "Human daily", consigne: creation.instructions, clock: creation.clock, template: "custom",
    taskMode: "native", profiles: creation.profiles, watchedConversationIDs: [], profileID: scope.key, executionHost: "local", roots }, Date.now(), current)
  const fence = new WorktreeDeletionFence(), deps = { workspaceManager: manager, worktreeDeletionFence: fence, settings, auth, bridgeToken: "private" }
  const app = Fastify({ logger: false })
  registerMissionRecurrenceControl(app, { manager, fence, settings, auth, bridgeToken: "private" } as never)
  t.after(() => app.close())
  const agent = (input: object) => controlAgentMissionSchedule(deps as never, "ses_child", { kind: "schedule",
    input: { owner: "daily", ...input } }, new AbortController().signal) as Promise<any>
  return { agent, store, state, calls, creation, app, directory, callerDirectory, fence }
}

test("daily project discovery from owned Location B routes reads, receipts and controls to A and refuses a foreign project", async t => {
  const f = await fixture(t, true), id = "daily_human"
  assert.notEqual(f.callerDirectory, f.directory)
  assert.equal((await f.agent({ action: "list", limit: 1 })).schedules[0].missionID, id)
  assert.equal((await f.agent({ action: "read", missionID: id })).schedule.id, id)
  f.state.unreadableSnapshot = true
  const expectedRevision = (await f.store.read(id))!.revision
  const input = { action: "play", missionID: id, requestID: "from_sibling", expectedRevision }
  assert.equal((await f.agent(input)).status, 200)
  assert.equal(f.calls.at(-1).location.directory, f.directory)
  const writes = f.calls.length
  assert.equal((await f.agent({ ...input, action: "read", receiptAction: "play" })).status, 200)
  assert.equal(f.calls.length, writes)
  assert.equal((await f.agent(input)).status, 200)
  assert.equal(f.state.effects, 1)
  f.state.foreignTarget = true
  for (const request of [{ action: "list" }, { action: "read", missionID: id }, { ...input, action: "stop", requestID: "foreign" }])
    await assert.rejects(f.agent(request))
  assert.equal(f.calls.length, writes + 1)
})

test("owned agent reads and controls a human daily document with signed identity and idempotent native records", async t => {
  const f = await fixture(t)
  assert.equal((await f.agent({ action: "list" })).schedules[0].missionID, "daily_human")
  const id = "daily_human"
  for (const action of ["play", "pause", "resume", "stop"]) {
    const expectedRevision = (await f.store.read(id))!.revision, requestID = `daily_${action}`
    const input = { action, missionID: id, requestID, expectedRevision }
    assert.equal((await f.agent(input)).status, 200, action)
    const effects = f.state.effects, revision = (await f.store.read(id))!.revision
    assert.equal((await f.agent(input)).status, 200, `${action} replay`)
    assert.equal(f.state.effects, effects)
    assert.equal((await f.store.read(id))!.revision, revision)
  }
  f.state.owned = false
  await assert.rejects(f.agent({ action: "read", missionID: id }))
})

test("agent daily Run now admits once and Check observes only that paused pending passage", async t => {
  const f = await fixture(t), id = "daily_human"
  const manual = { action: "run-now", missionID: id, requestID: "one_manual", expectedRevision: (await f.store.read(id))!.revision }
  assert.equal((await f.agent(manual)).outcome, "accepted")
  assert.equal((await f.agent(manual)).outcome, "accepted")
  assert.equal(f.state.effects, 1)
  const check = { action: "check", missionID: id, requestID: "check_original", expectedRevision: (await f.store.read(id))!.revision }
  assert.equal((await f.agent(check)).status, 200)
  const effects = f.state.effects
  assert.equal((await f.agent(check)).status, 200)
  assert.equal(f.state.effects, effects)
})

test("daily agent creation stays paused and exact creation replay never writes twice", async t => {
  const f = await fixture(t), input = { action: "create", requestID: "daily_create", creation: f.creation }
  const first = await f.agent(input)
  assert.equal(first.status, 200)
  assert.equal(first.schedule.state, "paused")
  const writes = f.calls.length
  assert.equal((await f.agent(input)).schedule.id, first.schedule.id)
  assert.equal(f.calls.length, writes)
  assert.equal((await f.agent({ ...input, creation: { ...f.creation, instructions: "Different" } })).status, 409)
})

test("daily creation recovery reads the original digest without dispatch, including an absent creation", async t => {
  const f = await fixture(t)
  const read = { action: "read", requestID: "daily_lost_creation", creation: f.creation }
  assert.equal((await f.agent(read)).pending, true)
  assert.equal(f.calls.length, 0)
  f.state.loseACK = true
  const lost = await f.agent({ ...read, action: "create" })
  assert.equal(lost.status, 503)
  assert.ok(lost.missionID)
  const writes = f.calls.length
  const recovered = await f.agent(read)
  assert.equal(recovered.status, 200)
  assert.equal(recovered.schedule.id, lost.missionID)
  assert.equal(f.calls.length, writes)
  assert.equal((await f.agent({ ...read, creation: { ...f.creation, instructions: "Another input" } })).status, 409)
})

test("lost daily ACK holds human concurrency and exact read settles without resending", async t => {
  const f = await fixture(t), id = "daily_human", expectedRevision = (await f.store.read(id))!.revision
  f.state.loseACK = true; f.state.unknown = true
  const input = { action: "play", missionID: id, requestID: "lost_daily", expectedRevision }
  assert.equal((await f.agent(input)).status, 503)
  const writes = f.calls.length
  assert.equal((await f.agent(input)).status, 503)
  const human = await f.app.inject({ method: "POST", url: `/api/workspaces/owned/missions/recurrence/${id}/control`,
    payload: { action: "stop", requestID: "racing_human", expectedRevision } })
  assert.notEqual(human.statusCode, 200)
  f.state.unknown = false
  const deleting = f.fence.run(f.directory, [f.directory], async () => {})
  assert.equal((await f.agent({ action: "read", missionID: id, requestID: input.requestID, expectedRevision, receiptAction: "play" })).status, 200)
  await deleting
  assert.equal(f.calls.length, writes)
})

test("daily wire action fields separate read, creation, original receipt and explicit partial retry", () => {
  for (const input of [{ owner: "daily", action: "list", limit: 8 }, { owner: "daily", action: "pause", missionID: "daily_fixture", requestID: "pause_original", expectedRevision: 0, retry: true }])
    assert.doesNotThrow(() => scheduleToolInput.parse(input))
  for (const input of [{ owner: "daily", action: "read", missionID: "daily_fixture", requestID: "missing_identity" },
    { owner: "daily", action: "configure" }, { action: "create", requestID: "forged" },
    { owner: "daily", action: "create", requestID: "new_daily", creation: {} }])
    assert.throws(() => scheduleToolInput.parse(input))
})
