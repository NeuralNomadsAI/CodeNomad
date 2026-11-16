import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import Fastify from "fastify"
import { Effect } from "effect"
import { canonicalScope } from "../../host-lifetime/protocol"
import { ownerFixture } from "../../opencode/missions/native-schedule-owner-test-fixture"
import { NativeScheduleCalendarOwner, NativeScheduleControlRefusal, nativeScheduleOwnerControlReceipt } from "../../opencode/missions/native-schedule-owner"
import { nativeScheduleOwnerBindings } from "../../opencode/missions/native-schedule-owner-bindings"
import { assertMissionScheduleAgentRequest } from "../../opencode/missions/native-mission-schedule-authority"
import { missionScheduleRequestSchema, missionSchedulePayloadDigest } from "../../missions/mission-schedule-contract"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { missionScheduleView } from "../../missions/mission-schedule-view"
import { MissionDocumentPassageEngine } from "../../missions/mission-document-passage-engine"
import { finishMissionDocumentDeletion } from "../../missions/mission-document-deletion"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { controlAgentMissionSchedule } from "./mission-agent-schedule"
import { registerMissionScheduled } from "./mission-scheduled"
import { verifyRecurrenceRequest } from "./mission-recurrence-proof"
import { scheduledMissionHold } from "./mission-scheduled-holds"
import { scheduleToolInput } from "../../missions/schedule-tool"
import type { NativeScheduleActivationJournal } from "../../opencode/native-schedule-settings-activation"
import { missionDocumentSummary } from "../../missions/mission-document-one-time"

async function fixture(t: test.TestContext, agentCreated = false) {
  const f = await ownerFixture(t)
  const yaml = path.join(f.directory, "profile.yaml")
  await writeFile(yaml, "server: {}\n")
  const scope = canonicalScope("stable", yaml, f.directory, f.directory), workspace = { id: "owned" }
  const state = { owned: true, projectID: "project", ambiguous: false, loseACK: false, receiptsUnknown: false, admissions: 0,
    blocked: undefined as Promise<void> | undefined, writes: [] as ReturnType<typeof missionScheduleRequestSchema.parse>[], activationOff: false,
    lastError: undefined as unknown, activationWrites: 0, loseActivationACK: false, capability: true }
  const config = { ...f.configuration, profileID: scope.key, executionHost: "local",
    launch: { when: [{ kind: "cron" as const, expression: "0 9 * * *", zone: "UTC" }] } }
  const created = await f.store.create("owned_schedule", config, f.now, f.current, null, agentCreated ? {
    requestID: "agent_created", digest: "a".repeat(64), author: { coordinatorSessionID: "ses_other_author" },
    input: { objective: config.objective, template: "custom", startOnCreation: false },
  } : undefined)
  await f.store.change(created.id, created.revision, f.current, doc => {
    doc.scheduleActivation = { requestID: "ready_settings", expectedRevision: 0, authority: "a".repeat(64), state: "ready", targets: [], effectiveOrigin: null }
  })
  const read = async () => {
    const doc = await f.store.read(created.id)
    assert.ok(doc && !("deletedAt" in doc))
    return doc
  }
  const owner = new NativeScheduleCalendarOwner({ store: f.store, native: f.native,
    bindings: nativeScheduleOwnerBindings(f.ctx, Effect.runPromise), installation: f.installation,
    profileSource: { profileID: scope.key, executionHost: "local", configYamlPath: yaml }, current: f.current,
    now: () => Date.now() })
  const engine = new MissionDocumentPassageEngine(f.store, {
    incarnation: "fixture", now: Date.now, current: f.current,
    verifyWake: async () => assert.fail("No calendar wakes"),
    coverage: async () => ({ complete: true, wakes: [], current: f.current }),
    snapshot: async () => ({ news: { triggers: true, conditions: true }, checkpoints: [], current: f.current }),
    admit: async doc => {
      if (doc.pending!.admittedAt === null) state.admissions++
      return { kind: doc.pending!.admittedAt === null ? "admitted" : "recorded", passageID: doc.pending!.id,
        messageID: doc.pending!.messageID, coordinatorSessionID: doc.pending!.coordinatorSessionID, at: Date.now() }
    },
    observe: async () => ({ outcome: "completed", current: f.current }),
  })
  const rpc = {
    documentCapabilities: async () => ({ version: 1, ...(state.capability ? { agentScheduleControl: true } : {}) }),
    documentActivation: async (input: any) => {
      const before = await read()
      if (input.action === "read") return { document: missionDocumentSummary(before) }
      state.activationWrites++
      const doc = await f.store.change(before.id, input.action === "prepare" ? input.expectedRevision : before.revision, f.current, value => {
        if (input.action === "prepare") value.scheduleActivation = { requestID: input.requestID, expectedRevision: input.expectedRevision,
          authority: input.authority, targets: input.targets, state: "prepared" }
        else if (input.action === "ready") { value.scheduleActivation!.state = "ready"; value.scheduleActivation!.effectiveOrigin = null }
        else if (input.action === "failed") value.scheduleActivation!.state = "failed"
        else assert.fail("Unexpected activation action")
      })
      if (input.action === "ready" && state.loseActivationACK) throw new Error("Lost activation ACK")
      return { document: missionDocumentSummary(doc) }
    },
    scheduleList: async () => ({ version: 1, projectID: "project", schedules: [missionScheduleView(await read()).document] }),
    scheduleRead: async ({ missionID, requestID }: { missionID: string; requestID?: string }) => {
      const doc = await f.store.read(missionID)
      if (requestID && state.receiptsUnknown) return { document: null, pending: true }
      const result = missionScheduleView(doc)
      if (!doc || "deletedAt" in doc || !requestID) return result
      const original = nativeScheduleOwnerControlReceipt(doc, requestID)
      const manual = [...doc.history, ...(doc.pending ? [doc.pending] : [])].find(p => p.origin.kind === "manual" && p.origin.requestID === requestID)
      if (manual) return { ...result, pending: !manual.admittedAt, document: { ...result.document, control: {
        requestID, action: "run-now", expectedRevision: manual.manualExpectedRevision, pending: !manual.admittedAt } } }
      return { ...result, pending: !original || original.pending,
        document: { ...result.document, control: original ? { requestID: original.requestID, action: original.action,
          expectedRevision: original.expectedRevision, pending: original.pending } : null } }
    },
    scheduleControl: async (raw: unknown) => {
      const request = missionScheduleRequestSchema.parse(raw), { proof, ...body } = request.transport
      assert.equal(proof, signNativeRecurrenceControl(body, "private-token"))
      assert.equal(body.digest, recurrenceControlRequestDigest((({ digest: _, ...rest }) => rest)(body)))
      await verifyRecurrenceRequest(body, { manager, settings, auth: {
        isAuthEnabled: () => true, getCookieName: () => "cookie", getSessionFromHeaders: () => ({ sessionId: "human_cookie" }),
      } } as never, new AbortController().signal)
      const previous = await f.store.read(request.missionID)
      assertMissionScheduleAgentRequest(request, previous && !("deletedAt" in previous) ? previous : undefined)
      state.writes.push(request)
      await state.blocked
      if (previous && "deletedAt" in previous) {
        if (request.action !== "delete" || request.requestID !== previous.requestID || request.expectedRevision !== previous.expectedRevision
          || (request.deleteManagedSessions ?? false) !== previous.deleteManagedSessions)
          return { document: null, pending: false, refusal: { missionID: request.missionID, requestID: request.requestID, action: request.action,
            expectedRevision: request.expectedRevision, payloadDigest: missionSchedulePayloadDigest(request), reason: "control-conflict" } }
        return missionScheduleView(previous)
      }
      if (request.action === "run-now") await engine.runNow(request)
      else {
        try { await owner.control(request as never) }
        catch (error) {
          if (error instanceof NativeScheduleControlRefusal) return { document: null, pending: false, refusal: error.refusal }
          throw error
        }
        if (request.action === "delete") {
          const doc = await f.store.read(request.missionID)
          if (doc && !("deletedAt" in doc)) await finishMissionDocumentDeletion(use => use(f.store), use => use(f.store),
            { missionID: doc.id, ...doc.deletion! }, Date.now(), f.current, true)
        }
      }
      const result = await rpc.scheduleRead({ missionID: request.missionID, requestID: request.requestID })
      if (state.loseACK) throw new Error("Lost ACK after committed native operation")
      return result
    },
  }
  const client = { rpc: () => ({ ...rpc, scheduleControl: (raw: unknown) => rpc.scheduleControl(raw).catch(error => {
    state.lastError = error; throw error
  }) }),
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: state.projectID, location: { directory: f.directory } }) },
    location: { get: async ({ location }: { location: { directory: string } }) => ({ ...location, project: { id: "project", canonical: f.directory } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) } }
  const connection = { client, assertCurrent: f.current }, anotherConnection = { client, assertCurrent: f.current }
  const manager = {
    list: () => state.ambiguous ? [workspace, { id: "another" }] : [workspace],
    get: () => workspace, getServiceLocation: () => ({ directory: f.directory }),
    getSharedServiceConnection: async (id: string) => id === "another" ? anotherConnection : connection,
    ownsLocation: async (_id: string, location: { directory: string }) => state.owned && location.directory === f.directory,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === f.directory ? directory : undefined,
    getWorktreeIdentityForPath: async () => f.directory, getServiceWslDistro: () => undefined,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
  }
  const settings = { getProfileScope: () => scope, configYamlPathForAuthority: () => yaml }
  const fence = new WorktreeDeletionFence(5000)
  const deps = { workspaceManager: manager, worktreeDeletionFence: fence, settings, bridgeToken: "private-token",
    auth: { isAuthEnabled: () => true, getSessionFromRequest: () => ({ sessionId: "human_cookie", username: "human" }) },
    scheduleCapability: { read: async () => ({ api: { available: true }, enabled: !state.activationOff }) },
    scheduleSettingsActivation: {
      prepare: async () => {
        if (state.activationOff) throw new Error("Explicit OFF")
        return { authority: "b".repeat(64), targets: [] }
      },
      apply: async (_id: string, _location: unknown, plan: any, journal: NativeScheduleActivationJournal) => {
        await journal.prepared(plan); await journal.ready(null)
      },
      verify: async () => { if (state.activationOff) throw new Error("Explicit OFF") },
    } }
  const app = Fastify({ logger: false })
  registerMissionScheduled(app, deps as never)
  t.after(() => app.close())
  const agent = (input: object, sessionID = "ses_subagent") => controlAgentMissionSchedule(deps as never, sessionID,
    { kind: "schedule", input }, new AbortController().signal) as Promise<any>
  const human = (input: object) => app.inject({ method: "POST", url: "/api/workspaces/owned/missions/owned_schedule/schedule", payload: input })
  const action = async (action: string, requestID = `agent_${action}`, extra = {}) => agent({
    missionID: created.id, action, requestID, expectedRevision: (await read()).revision, ...extra })
  return { ...f, read, config, state, fence, agent, human, action, rpc, app }
}

test("agent scheduling diagnostics and activation receipt reads are passive, explicit activation shares preparation", async t => {
  const f = await fixture(t)
  const before = await f.read()
  const diagnostics = await f.agent({ action: "capabilities" })
  assert.equal(diagnostics.activation.available, true)
  assert.equal((await f.read()).revision, before.revision)
  assert.equal(f.state.activationWrites, 0)
  f.state.activationOff = true
  assert.equal((await f.agent({ action: "capabilities" })).activation.available, false)
  assert.equal((await f.read()).revision, before.revision)
  f.state.activationOff = false
  await f.store.change(before.id, before.revision, f.current, doc => { doc.scheduleActivation = null })
  const expectedRevision = (await f.read()).revision
  const identity = { missionID: before.id, requestID: "explicit_activation", expectedRevision }
  await f.agent({ action: "activation-read", ...identity })
  assert.equal(f.state.activationWrites, 0)
  const activated = await f.agent({ action: "activate", ...identity })
  assert.equal(activated.document.scheduleActivation.state, "ready")
  const writes = f.state.activationWrites
  assert.equal((await f.agent({ action: "activation-read", ...identity })).document.scheduleActivation.state, "ready")
  assert.equal((await f.agent({ action: "activate", ...identity })).document.scheduleActivation.state, "ready")
  assert.equal(f.state.activationWrites, writes)
  assert.equal(f.state.writes.length, 0, "activation never sends Play or starts a passage")
})

for (const agentCreated of [false, true]) test(`agent controls ${agentCreated ? "agent" : "human"} schedule through native owner and passage admission`, async t => {
  const f = await fixture(t, agentCreated)
  const page = await f.agent({ action: "list" })
  assert.equal(page.schedules[0].missionID, "owned_schedule")
  assert.equal((await f.agent({ action: "read", missionID: "owned_schedule" })).document.id, "owned_schedule")
  for (const action of ["play", "pause", "resume", "check", "play"] as const) {
    const revision = (await f.read()).revision, requestID = `first_${action}_${revision}`
    const input = { action, requestID, expectedRevision: revision, missionID: "owned_schedule" }
    assert.equal((await f.agent(input)).status, 200, `${action}: ${String(f.state.lastError)}`)
    const effects = () => f.calls.filter(call => /^(create|pause|resume|remove|carrier):/.test(call)).length
    const after = await f.read(), calls = effects()
    assert.equal((await f.agent(input)).status, 200, `${action} replay`)
    assert.equal((await f.read()).revision, after.revision)
    assert.equal(effects(), calls, "replay has no calendar effects")
  }
  const before = await f.read()
  const { roots: _, profileID: _profile, executionHost: _host, ...configuration } = { ...f.config, notes: "Agent edit" }
  const configure = { action: "configure", requestID: "edit_schedule", expectedRevision: before.revision, configuration, missionID: before.id }
  assert.equal((await f.agent(configure)).status, 200)
  assert.equal((await f.read()).configuration.coordinatorSelectionAuthor?.coordinatorSessionID, "ses_subagent")
  assert.equal((await f.agent(configure)).status, 200)
  assert.equal((await f.agent({ ...configure, configuration: { ...configuration, notes: "Conflicting input" } })).status, 409)
  const now = { action: "run-now", requestID: "single_manual", expectedRevision: (await f.read()).revision, missionID: before.id }
  const [first, concurrent] = await Promise.all([f.agent(now), f.agent(now)])
  assert.ok([first.status, concurrent.status].includes(200), String(f.state.lastError))
  assert.equal((await f.agent(now)).status, 200)
  assert.equal(f.state.admissions, 1)
  assert.equal((await f.action("stop")).status, 200)
  assert.notEqual((await f.action("resume", "after_terminal_stop")).status, 200)
  // The rejected terminal action has an uncertain transport outcome; exact Check
  // uses the same shared hold. A separate fixture qualifies deletion below.
})

for (const agentCreated of [false, true]) test(`delete ${agentCreated ? "agent" : "human"} schedule and exact replay preserve tombstone`, async t => {
  const f = await fixture(t, agentCreated), revision = (await f.read()).revision
  const input = { action: "delete", requestID: "delete_once", expectedRevision: revision, missionID: "owned_schedule" }
  assert.equal((await f.agent(input)).status, 200)
  const tombstone = await f.store.read("owned_schedule")
  assert.ok(tombstone && "deletedAt" in tombstone)
  assert.equal((await f.agent(input)).status, 200)
  assert.deepEqual(await f.store.read("owned_schedule"), tombstone)
  assert.equal((await f.agent({ ...input, deleteManagedSessions: true })).status, 409)
  assert.equal((await f.human({ action: "delete", requestID: "other_delete", expectedRevision: revision })).statusCode, 409)
})

for (const agentCreated of [false, true]) for (const action of ["play", "pause", "stop", "resume", "run-now", "check", "configure", "delete"] as const)
test(`lost ${action} ACK on ${agentCreated ? "agent" : "human"} schedule shares human hold; read/repeat never resends`, async t => {
  const f = await fixture(t, agentCreated)
  if (action === "resume" || action === "run-now") {
    assert.equal((await f.action("play", "setup_play")).status, 200)
    if (action === "resume") assert.equal((await f.action("pause", "setup_pause")).status, 200)
  }
  const expectedRevision = (await f.read()).revision
  let release!: () => void
  f.state.blocked = new Promise<void>(done => { release = done })
  const { roots: _roots, profileID: _profile, executionHost: _host, ...configuration } = f.config
  const requestID = `lost_${action}`, input = { action, requestID, expectedRevision, missionID: "owned_schedule",
    ...(action === "configure" ? { configuration: { ...configuration, notes: "Lost edit ACK" } } : {}) }
  const initialWrites = f.state.writes.length
  f.state.loseACK = true
  const pending = f.agent(input)
  // A deterministic native RPC rendezvous, without polling timers.
  const original = f.state.writes.push.bind(f.state.writes)
  const entered = new Promise<void>(done => { f.state.writes.push = (...items) => { const result = original(...items); done(); return result } })
  await Promise.race([entered, pending.then(() => assert.fail("Control refused before dispatch"))])
  assert.notEqual((await f.human({ action: "stop", requestID: "racing_human", expectedRevision })).statusCode, 200)
  release()
  assert.equal((await pending).status, 503)
  f.state.receiptsUnknown = true
  assert.equal((await f.agent(input)).status, 503)
  assert.equal(f.state.writes.length, initialWrites + 1)
  assert.ok(scheduledMissionHold(f.fence, "owned_schedule"))
  f.state.receiptsUnknown = false
  assert.equal((await f.agent({ action: "read", missionID: "owned_schedule", requestID })).status, 200, String(f.state.lastError))
  assert.equal(f.state.writes.length, initialWrites + 1)
  assert.equal(scheduledMissionHold(f.fence, "owned_schedule"), undefined)
})

test("foreign projects, ambiguous backends, invalid configuration and forged HTTP agent principals refuse", async t => {
  const f = await fixture(t)
  f.state.projectID = "foreign"
  await assert.rejects(f.agent({ action: "list" }))
  f.state.projectID = "project"; f.state.ambiguous = true
  await assert.rejects(f.agent({ action: "list" }))
  f.state.ambiguous = false; f.state.owned = false
  await assert.rejects(f.agent({ action: "list" }))
  f.state.owned = true
  for (const launch of [{ when: [{ kind: "cron", expression: "* * * * * *", zone: "UTC" }] }, { when: [{ kind: "now" }, { kind: "now" }] }]) {
    await assert.rejects(f.action("configure", "invalid_config", { configuration: { ...f.config, launch } }))
  }
  assert.equal(f.state.writes.length, 0)
  f.state.capability = false
  assert.equal((await f.action("play", "old_native_contract")).code, "schedule-control-unavailable")
  assert.equal(f.state.activationWrites, 0)
  assert.equal(scheduledMissionHold(f.fence, "owned_schedule"), undefined)
  f.state.capability = true
  assert.equal((await f.human({ action: "play", requestID: "forged_agent", expectedRevision: 2,
    principal: { kind: "agent", author: { coordinatorSessionID: "ses_subagent" } } })).statusCode, 400)
  f.state.activationOff = true
  await assert.rejects(f.action("play", "explicit_off"))
  assert.equal(f.state.writes.length, 0)
})

test("strict model codec rejects mixed read/mutation fields and accepts editor criteria", () => {
  for (const input of [{ action: "list", configuration: {} }, { action: "read", missionID: "valid", expectedRevision: 1 },
    { action: "pause", missionID: "valid", requestID: "req" }, { action: "pause", missionID: "valid", requestID: "req", expectedRevision: 1, retry: true }])
    assert.equal(scheduleToolInput.safeParse(input).success, false)
  assert.ok(missionSchedulePayloadDigest({}).length === 64)
})

test("fresh settings activation advances native CAS while exact Play replay preserves its original tool revision", async t => {
  const f = await fixture(t), before = await f.read()
  await f.store.change(before.id, before.revision, f.current, value => { value.scheduleActivation = null })
  const input = { action: "play", missionID: before.id, requestID: "activate_and_play", expectedRevision: (await f.read()).revision }
  assert.equal((await f.agent(input)).status, 200)
  assert.equal(f.state.writes[0].expectedRevision, input.expectedRevision + 2)
  const after = await f.read(), effects = f.calls.filter(call => call.startsWith("create:")).length
  assert.equal((await f.agent(input)).status, 200)
  assert.equal((await f.read()).revision, after.revision)
  assert.equal(f.calls.filter(call => call.startsWith("create:")).length, effects)
  assert.equal(f.state.activationWrites, 2)
})

test("lost activation acknowledgement recovers read-only and cannot continue Play on retry", async t => {
  const f = await fixture(t), before = await f.read()
  await f.store.change(before.id, before.revision, f.current, value => { value.scheduleActivation = null })
  const input = { action: "play", missionID: before.id, requestID: "lost_activation", expectedRevision: (await f.read()).revision }
  f.state.loseActivationACK = true
  await assert.rejects(f.agent(input))
  const writes = f.state.activationWrites
  assert.equal((await f.agent(input)).status, 503)
  assert.equal((await f.agent({ action: "read", missionID: before.id, requestID: input.requestID })).status, 503)
  assert.equal(f.state.activationWrites, writes)
  assert.equal(f.state.writes.length, 0)
  assert.equal((await f.read()).firstPlayedAt, null)
})
