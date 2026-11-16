import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { canonicalScope } from "../../host-lifetime/protocol"
import { missionScheduleID, missionScheduleRequestSchema, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import { automaticMissionStartID } from "../../missions/preparation-result"
import type { MissionCreationMetadata } from "../../missions/creation-defaults"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { NativeScheduleActivationRefused } from "../../opencode/native-schedule-settings-activation"
import type { NativeScheduleActivationJournal } from "../../opencode/native-schedule-settings-activation"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareScheduledCoordinatorMission } from "./mission-prepare-scheduled"
import { scheduledMissionHold } from "./mission-scheduled-holds"
import { MissionControl } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionScheduleView } from "../../missions/mission-schedule-view"
import { resolveMissionCreationDefaults } from "../../missions/profile-defaults"
import type { MissionJsonValue } from "../../missions/model"
import type { MissionDocument } from "../../missions/mission-document"
import type { MissionPrepareRequest } from "../../missions/control-types"

const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
const input = { requestID: "prepare_scheduled", objective: "Read owned sources", template: "custom" as const, taskMode: "native" as const,
  profiles: { coordinator: selection, roles: { specialist: selection } },
  launch: { when: [{ kind: "cron" as const, expression: "0 9 * * *", zone: "UTC" }] } }
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture(t: test.TestContext) {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const temporary = await mkdtemp(path.join(tmpdir(), "opencode", "prepare-schedule-")), root = await realpath(temporary)
  const yaml = path.join(root, "profile.yaml")
  await writeFile(yaml, "server: {}\n")
  const profile = canonicalScope("stable", yaml, root, root), workspace = {}, fence = new WorktreeDeletionFence(5000)
  const state = { capability: true, agentSchedulePreparation: true, owned: true, authorDirectory: root, profile, loseCreate: false, losePlay: false,
    activation: "ready" as "ready" | "off" | "unknown", activationCalls: 0, activationWrites: 0,
    readPending: false, sourceMissionID: undefined as string | undefined,
    writes: [] as MissionScheduleRequest[], documents: new Map<string, any>(), receipts: new Map<string, any>(),
    beforeWrite: undefined as (() => Promise<void>) | undefined }
  const authorSessionID = "ses_author", missionID = missionScheduleID("project", root, input.requestID)
  const nativeStore = new NativeMissionDocumentStore({
    get: async key => state.documents.get(key.slice(key.lastIndexOf("/") + 1)),
    compareAndSet: async (_key, value, expected, current) => {
      current()
      const document = value as unknown as MissionDocument
      assert.equal(state.documents.get(document.id)?.revision ?? null, expected)
      state.documents.set(document.id, structuredClone(document))
    },
  }, "project", root)
  const snapshot = () => ({ projectID: "project", missions: [] })
  const view = (doc: any, control: any) => ({ pending: false, document: { ...missionScheduleView(doc).document, control: { ...control, pending: false } } })
  const rpc = {
    snapshot: async () => snapshot(),
    documentCapabilities: async () => ({ version: 1, ...(state.capability ? { automaticStart: true } : {}),
      ...(state.agentSchedulePreparation ? { agentSchedulePreparation: true } : {}) }),
    scheduleRead: async ({ missionID: id, requestID }: { missionID: string; requestID: string }) => {
      if (state.readPending) return { document: null, pending: true }
      const doc = state.documents.get(id), original = state.receipts.get(requestID)
      return doc && original ? view(doc, original) : { document: null, pending: false }
    },
    scheduleControl: async (raw: unknown, options: { signal?: AbortSignal }) => {
      assert.equal(options.signal, undefined)
      const request = missionScheduleRequestSchema.parse(raw), { proof, ...identity } = request.transport
      assert.equal(proof, signNativeRecurrenceControl(identity, "fixture-token"))
      assert.equal(identity.digest, recurrenceControlRequestDigest((({ digest: _, ...rest }) => rest)(identity)))
      assert.equal("sessionID" in identity, false, "Agent proof never contains a cookie surrogate")
      assert.equal("principal" in identity && identity.principal?.kind, "agent")
      await state.beforeWrite?.()
      state.writes.push(request)
      const control = { requestID: request.requestID, action: request.action, expectedRevision: request.expectedRevision }
      state.receipts.set(request.requestID, control)
      if (request.action === "create") {
        const previous = state.documents.get(request.missionID)
        if (previous) return { ...view(previous, control), acknowledgement: "recovered" }
        const doc = await nativeStore.create(request.missionID, request.configuration!, Date.now(), () => true, null, request.creation)
        if (state.loseCreate) throw new Error("Lost Create acknowledgement")
        return { ...view(doc, control), acknowledgement: "fresh" }
      }
      assert.equal(request.action, "play", "Agent helper only creates and first-Plays")
      const doc = state.documents.get(request.missionID)
      assert.equal(request.requestID, doc.creation.automaticStart.requestID)
      assert.equal(request.expectedRevision, doc.revision)
      assert.equal(doc.creation.automaticStart.attempted, false)
      assert.equal(doc.scheduleActivation.state, "ready")
      doc.creation.automaticStart.attempted = true
      doc.firstPlayedAt = Date.now()
      doc.revision++; doc.state = "running"
      if (state.losePlay) throw new Error("Lost Play acknowledgement")
      return view(doc, control)
    },
    documentActivation: async (value: any) => {
      const doc = state.documents.get(value.missionID)
      if (value.action === "prepare") {
        assert.equal(doc.revision, value.expectedRevision)
        doc.scheduleActivation = { requestID: value.requestID, expectedRevision: value.expectedRevision,
          authority: value.authority, targets: value.targets, state: "prepared" }
        doc.revision++
      } else if (value.action === "ready") { doc.scheduleActivation.state = "ready"; doc.scheduleActivation.effectiveOrigin = value.effectiveOrigin; doc.revision++ }
      else if (value.action === "failed") { doc.scheduleActivation.state = "failed"; doc.revision++ }
      return { document: structuredClone(doc) }
    },
  }
  const client = {
    rpc: () => rpc,
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project",
      location: { directory: state.authorDirectory }, ...(state.sourceMissionID ? { metadata: { "codenomad.mission": { missionID: state.sourceMissionID } } } : {}) }) },
    location: { get: async ({ location }: { location: { directory: string } }) => ({ ...location, project: { id: "project", canonical: root } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
  }
  const connection = { client, assertCurrent() {} }
  const manager = { get: () => workspace, getServiceLocation: () => ({ directory: root }), getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id: string, location: { directory: string }) => state.owned && location.directory === root,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === root ? root : undefined,
    getWorktreeIdentityForPath: async () => root, getServiceWslDistro: () => undefined,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix" }
  const settings = { getProfileScope: () => state.profile, configYamlPathForAuthority: () => yaml }
  const scheduleSettingsActivation = {
    prepare: async () => {
      state.activationCalls++
      if (state.activation === "off") throw new NativeScheduleActivationRefused({ reason: "explicit-off", provenance: "environment", layer: "environment" })
      return { authority: "a".repeat(64), targets: [] }
    },
    apply: async (_id: string, _location: unknown, intent: any, journal: NativeScheduleActivationJournal) => {
      state.activationWrites++
      await journal.prepared(intent)
      if (state.activation === "unknown") throw new Error("Unknown activation")
      await journal.ready(null)
    },
    verify: async () => {},
  }
  const prepare = (overrides: Partial<MissionPrepareRequest> & { missionID?: string; observeOnly?: true } = {}) =>
    prepareScheduledCoordinatorMission({ manager, fence, workspaceID: "owned", authorSessionID, input: { ...input, ...overrides },
      signal: new AbortController().signal, settings, bridgeToken: "fixture-token", scheduleSettingsActivation } as never)
  t.after(async () => { await rm(temporary, { recursive: true, force: true }) })
  const values = new Map<string, MissionJsonValue>()
  const makeControl = () => new MissionControl({ project: { id: "project", canonical: root, location: { directory: root } },
    storage: { get: async key => values.get(key), set: async (key, value) => { values.set(key, value) },
      scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    documents: use => use(nativeStore), documentReads: use => use(nativeStore),
    sessions: { get: value => client.session.get(value), create: async () => assert.fail("No coordinator during scheduling"),
      prompt: async () => assert.fail("No direct prompt"), synthetic: async () => assert.fail("No direct input") },
    transport: { prompt: async () => {}, synthetic: async () => {},
      resolveCreationDefaults: async (_id, requested) => resolveMissionCreationDefaults({ ...requested, preferences: undefined }),
      prepare: (_id, value) => prepare(value) },
  })
  return { prepare, state, fence, missionID, root, makeControl }
}

test("scheduled preparation stores its signed author, exact input and automatic intention, without activating by default", async t => {
  const f = await fixture(t)
  const result = await f.prepare({ watchedConversationIDs: ["ses_followed"], coordinatorSessionID: "ses_existing" })
  assert.equal(result.outcome, "prepared")
  assert.equal(result.target?.kind, "schedule")
  assert.equal(result.outcome === "prepared" && result.acknowledgement, "fresh")
  const request = f.state.writes[0]
  assert.equal(request.missionID, f.missionID)
  assert.equal(request.action, "create")
  assert.deepEqual(request.creation?.author, { coordinatorSessionID: "ses_author" })
  assert.equal(request.creation?.input?.startOnCreation, false)
  assert.deepEqual(request.configuration?.watchedConversationIDs, ["ses_followed"])
  assert.equal(request.configuration?.coordinatorSessionID, "ses_existing")
  assert.equal(f.state.activationCalls, 0)
  assert.equal(scheduledMissionHold(f.fence, f.missionID), undefined)
})

for (const lost of ["create", "play"] as const) test(`domain recovery of lost ${lost} ACK settles the backend hold through observation only`, async t => {
  const f = await fixture(t), control = f.makeControl(), request = { ...input, startOnCreation: lost === "play" }
  f.state.loseCreate = lost === "create"; f.state.losePlay = lost === "play"
  const first = await control.prepare("ses_author", request).catch(error => {
    assert.equal((error as { code?: string }).code, "prepare-uncertain")
    return { preparation: { outcome: "uncertain" } }
  })
  assert.equal(first.preparation.outcome, "uncertain")
  const missionID = f.state.writes[0].missionID, writes = f.state.writes.length, activationCalls = f.state.activationCalls
  assert.ok(scheduledMissionHold(f.fence, missionID))
  f.state.readPending = true
  assert.equal((await f.makeControl().prepare("ses_author", request)).preparation.outcome, "uncertain")
  assert.ok(scheduledMissionHold(f.fence, missionID))
  assert.equal(f.state.writes.length, writes)
  f.state.readPending = false; f.state.loseCreate = false; f.state.losePlay = false
  const result = await f.makeControl().prepare("ses_author", request)
  assert.equal(result.preparation.outcome, lost === "play" ? "activated" : "prepared")
  assert.equal("acknowledgement" in result.preparation && result.preparation.acknowledgement, "recovered")
  assert.equal(scheduledMissionHold(f.fence, missionID), undefined)
  assert.equal(f.state.writes.length, writes)
  assert.equal(f.state.activationCalls, activationCalls)
})

test("observe-only recovery with no retained document cannot dispatch creation", async t => {
  const f = await fixture(t)
  const result = await f.prepare({ observeOnly: true } as never)
  assert.equal(result.outcome, "uncertain")
  assert.equal(f.state.writes.length, 0)
  assert.equal(f.state.activationCalls, 0)
  assert.equal(scheduledMissionHold(f.fence, f.missionID), undefined)
})

test("fresh explicit automatic start activates the existing journal then guarded first Play once", async t => {
  const f = await fixture(t)
  assert.equal((await f.prepare({ startOnCreation: true })).outcome, "activated")
  assert.deepEqual(f.state.writes.map(value => value.action), ["create", "play"])
  assert.equal(f.state.writes[1].requestID, automaticMissionStartID(input.requestID))
  assert.equal(f.state.activationCalls, 1)
  assert.equal(f.state.activationWrites, 1)
  const retry = await f.prepare({ startOnCreation: true })
  assert.equal(retry.outcome, "activated")
  assert.equal(retry.outcome === "activated" && retry.acknowledgement, "recovered")
  assert.equal(f.state.writes.length, 2)
  assert.equal(f.state.activationWrites, 1)
})

test("automaticStart alone cannot admit agent scheduled preparation or reserve its hold", async t => {
  const f = await fixture(t)
  f.state.agentSchedulePreparation = false
  for (const startOnCreation of [false, true]) {
    const result = await f.prepare({ startOnCreation })
    assert.equal(result.outcome, "refused")
    assert.equal(result.outcome === "refused" && result.phase, "creation")
    assert.equal(f.state.writes.length, 0)
    assert.equal(f.state.documents.size, 0)
    assert.equal(f.state.activationCalls, 0)
    assert.equal(scheduledMissionHold(f.fence, f.missionID), undefined)
  }
})

test("lost creation ACK retains deletion fence and retry only reads, even with automatic start requested", async t => {
  const f = await fixture(t)
  f.state.loseCreate = true
  assert.equal((await f.prepare({ startOnCreation: true })).outcome, "uncertain")
  assert.ok(scheduledMissionHold(f.fence, f.missionID))
  let deleted = false
  const deletion = f.fence.run(f.root, [f.root], async () => { deleted = true })
  const retry = await f.prepare({ startOnCreation: true })
  assert.equal(retry.outcome, "prepared")
  assert.equal(retry.outcome === "prepared" && retry.acknowledgement, "recovered")
  await deletion
  assert.equal(deleted, true)
  assert.equal(f.state.writes.length, 1)
  assert.equal(f.state.activationCalls, 0)
})

test("lost first Play ACK is recovered from its exact original receipt without Play or activation replay", async t => {
  const f = await fixture(t)
  f.state.losePlay = true
  const lost = await f.prepare({ startOnCreation: true })
  assert.equal(lost.outcome, "uncertain")
  assert.equal(lost.outcome === "uncertain" && lost.phase, "start")
  assert.ok(scheduledMissionHold(f.fence, f.missionID))
  const retry = await f.prepare({ startOnCreation: true })
  assert.equal(retry.outcome, "activated")
  assert.equal(retry.outcome === "activated" && retry.acknowledgement, "recovered")
  assert.equal(f.state.writes.length, 2)
  assert.equal(f.state.activationWrites, 1)
  assert.equal(scheduledMissionHold(f.fence, f.missionID), undefined)
})

test("explicit OFF and uncertain activation keep the created target and send no Play", async t => {
  for (const activation of ["off", "unknown"] as const) {
    const f = await fixture(t)
    f.state.activation = activation
    const result = await f.prepare({ startOnCreation: true })
    assert.equal(result.outcome, activation === "off" ? "refused" : "uncertain")
    assert.equal(result.target?.kind, "schedule")
    assert.equal(f.state.writes.length, 1)
    assert.equal((await f.prepare({ startOnCreation: true })).outcome, "prepared")
    assert.equal(f.state.writes.length, 1)
  }
})

test("incomplete explicit profiles, wrong source, immediate criteria and missing capability refuse before dispatch", async t => {
  const f = await fixture(t)
  for (const overrides of [{ profiles: undefined }, { profiles: { coordinator: selection } }, { launch: { when: [] } }, { missionID: "msn_foreign" }])
    assert.equal((await f.prepare(overrides as never)).outcome, "refused")
  f.state.capability = false
  assert.equal((await f.prepare()).outcome, "refused")
  assert.equal(f.state.writes.length, 0)
})

test("negative or partial receipt retains the original hold and never permits another Create", async t => {
  const f = await fixture(t)
  f.state.loseCreate = true
  await f.prepare()
  f.state.readPending = true
  assert.equal((await f.prepare()).outcome, "uncertain")
  assert.ok(scheduledMissionHold(f.fence, f.missionID))
  assert.equal(f.state.writes.length, 1)
  f.state.readPending = false
  assert.equal((await f.prepare()).outcome, "prepared")
})

test("concurrent retry cannot clear the original busy hold", async t => {
  const f = await fixture(t), entered = defer(), release = defer()
  f.state.beforeWrite = async () => { entered.resolve(); await release.promise }
  const original = f.prepare()
  await entered.promise
  const held = scheduledMissionHold(f.fence, f.missionID)!
  assert.equal(held.busy, true)
  assert.equal((await f.prepare()).outcome, "uncertain")
  assert.equal(held.busy, true)
  release.resolve()
  assert.equal((await original).outcome, "prepared")
  assert.equal(f.state.writes.length, 1)
})

test("creation binding preserves original requested choices and resolved defaults independently", async t => {
  const f = await fixture(t)
  const creationDefaults: MissionCreationMetadata = { request: {}, profiles: input.profiles, taskMode: "native",
    origins: { coordinator: "preference", roles: { specialist: "preference" }, taskMode: "preference" } }
  assert.equal((await f.prepare({ creationDefaults })).outcome, "prepared")
  const creation = f.state.writes[0].creation!
  assert.deepEqual(creation.creationDefaults, creationDefaults)
  assert.equal(creation.input?.profiles, undefined)
  assert.equal(creation.input?.taskMode, undefined)
  assert.deepEqual(f.state.writes[0].configuration?.profiles, input.profiles)
  const conflict = await f.prepare({ creationDefaults, objective: "Different original request" })
  assert.equal(conflict.outcome, "refused")
  assert.equal(conflict.outcome === "refused" && conflict.code, "prepare-conflict")
  assert.equal(f.state.writes.length, 1)
})

test("a refused preflight cannot erase a previously uncertain creation", async t => {
  const f = await fixture(t)
  f.state.loseCreate = true
  assert.equal((await f.prepare()).outcome, "uncertain")
  f.state.owned = false
  assert.equal((await f.prepare()).outcome, "uncertain")
  assert.ok(scheduledMissionHold(f.fence, f.missionID))
  f.state.owned = true
  assert.equal((await f.prepare()).outcome, "prepared")
  assert.equal(f.state.writes.length, 1)
})
