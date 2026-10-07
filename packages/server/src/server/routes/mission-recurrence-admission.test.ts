import assert from "node:assert/strict"
import test from "node:test"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { RecurrenceConfig } from "../../missions/recurrence-contract"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { MissionRecurrenceRunner } from "../../missions/recurrence-runner"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import { createMissionRecurrenceAdmissionPreparation } from "./mission-recurrence-admission"
import { prepareMissionRootCreationLocation, type MissionCreationManager } from "./mission-creation-admission"
import type { MissionCreationPipelineManager } from "./mission-creation-pipeline"

const directory = "C:/isolated-recurrence/project"
const physical = "C:/isolated-recurrence/physical"
const projectID = "private-project"

async function fixture() {
  const data = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => structuredClone(data.get(key)),
    set: async (key, value, current) => { current?.(); data.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...data].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) })) }),
  }
  const store = new NativeMissionRecurrenceStore(storage, projectID, directory)
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config: RecurrenceConfig = { consigne: "Bounded private review", clock: { time: "07:00", zone: "UTC" },
    profileID: "profile", executionHost: "host", profiles: { coordinator: execution, roles: { specialist: execution } },
    taskMode: "independent", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    publication: { policy: "disabled", conversationIDs: [] } }
  const now = Date.parse("2026-10-01T07:00:00Z")
  await store.create("schedule", config, now, () => {})
  let owned = true, nativeDirectory = directory, live = true, reads = 0, effects = 0
  const connection = { assertCurrent: () => { if (!live) throw new Error("stale connection") },
    client: { location: { get: async () => { reads++; return { directory: nativeDirectory, project: { id: projectID } } } },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      session: { create: async () => { effects++; throw new Error("must not create") } } },
  } as unknown as ServiceConnection
  const manager = {
    get: () => ({}), getServiceLocation: () => ({ directory }), getSharedServiceConnection: async () => connection,
    ownsLocation: async (_workspaceID: string, location: { directory: string }) => owned && location.directory === directory,
    getServiceDirectoryForPath: async () => directory, getWorktreeIdentityForPath: async () => physical,
  } as unknown as MissionCreationManager & MissionCreationPipelineManager
  const fence = new WorktreeDeletionFence(20)
  const input = { manager, fence, connection, workspaceID: "workspace", projectID, projectCanonical: directory,
    signal: new AbortController().signal }
  const adapter = createMissionRecurrenceAdmissionPreparation(input)
  const reserve = () => store.reserve("schedule", 0, { kind: "manual", expectedRevision: 0, requestID: "manual_request", at: now }, now, () => {})
  return { input, adapter, store, reserve, now, data, counts: () => ({ reads, effects }),
    foreign: () => { owned = false }, redirect: () => { nativeDirectory = "C:/foreign" }, stale: () => { live = false } }
}

test("exact recurrence preparation shares ordinary physical admission and detaches frozen selections", async () => {
  const f = await fixture(), doc = await f.reserve(), original = structuredClone(doc)
  const prepared = await f.adapter.prepare(doc)
  doc.config.profiles!.coordinator!.model!.id = "changed"
  assert.deepEqual(prepared.request.profiles, original.config.profiles)
  assert.equal(prepared.request.taskMode, "independent")
  assert.equal(prepared.request.requestID, original.pending!.passage.id)
  assert.equal(prepared.messageID, original.pending!.passage.messageID)
  assert.equal("effect" in prepared, false, "preparation must not expose a write capability")
  let deletionRan = false
  const deletion = f.input.fence.run(physical, [physical], async () => { deletionRan = true })
  assert.equal(deletionRan, false)
  prepared.dispose()
  await deletion
  assert.equal(deletionRan, true)
  assert.deepEqual(f.counts(), { reads: 2, effects: 0 })
})

test("ordinary and recurrence preparation reject the same foreign ownership/native redirection", async () => {
  for (const change of ["foreign", "redirect", "stale"] as const) {
    const f = await fixture(), doc = await f.reserve()
    f[change]()
    await assert.rejects(f.adapter.prepare(doc))
    await assert.rejects(prepareMissionRootCreationLocation({ ...f.input, locations: [{ directory }], rootLocation: { directory },
      assertContract: async () => {}, operation: { key: "ordinary", workspaceID: "workspace", projectID,
        missionID: "mission", sessionID: "session", requestDigest: "digest" } }))
    await f.input.fence.run(physical, [physical], async () => {})
    assert.equal(f.counts().effects, 0)
  }
})

test("missing standing grant parks ONE durable passage, never calls beforeEffect or fabricates acceptance", async () => {
  const f = await fixture()
  const runner = new MissionRecurrenceRunner(f.store, { authorize: async () => () => {}, admit: f.adapter.admit }, () => f.now)
  assert.equal(await runner.trigger("schedule", 0, "manual_request"), "unknown")
  const pending = structuredClone((await f.store.read("schedule"))!.pending)
  assert.ok(pending)
  assert.equal(pending.admission, null)
  assert.equal(await runner.trigger("schedule", 1, "other_request"), "pending")
  assert.deepEqual((await f.store.read("schedule"))!.pending, pending)
  await assert.rejects(f.adapter.admit((await f.store.read("schedule"))!, async () => {
    assert.fail("missing standing grant must not reach actual effect fence")
  }), /recurrence-standing-grant-unavailable/)
  await f.input.fence.run(physical, [physical], async () => {})
  assert.equal(f.counts().effects, 0)
})

test("shared ordinary effect invokes late passage fence immediately before native dispatch and retains unknown effects", async () => {
  const f = await fixture(), order: string[] = []
  const prepared = await prepareMissionRootCreationLocation({ ...f.input, locations: [{ directory }], rootLocation: { directory },
    assertContract: async () => { order.push("contract") }, operation: { key: "ordinary", workspaceID: "workspace", projectID,
      missionID: "mission", sessionID: "session", requestDigest: "digest" } })
  order.length = 0
  await assert.rejects(prepared.effect(async () => { order.push("native"); throw new Error("lost acknowledgement") },
    async () => { order.push("beforeEffect"); return () => { order.push("fence") } }), /lost acknowledgement/)
  assert.deepEqual(order, ["contract", "beforeEffect", "fence", "native"])
  prepared.admission.release()
  assert.equal(prepared.admission.uncertain, true)
  await assert.rejects(f.input.fence.run(physical, [physical], async () => assert.fail("unknown write must retain permit")), /Timed out/)
})

test("late passage revocation prevents native effect and releases an undispatched permit", async () => {
  const f = await fixture()
  const prepared = await prepareMissionRootCreationLocation({ ...f.input, locations: [{ directory }], rootLocation: { directory },
    assertContract: async () => {}, operation: { key: "ordinary", workspaceID: "workspace", projectID,
      missionID: "mission", sessionID: "session", requestDigest: "digest" } })
  await assert.rejects(prepared.effect(async () => assert.fail("revoked passage must not create"),
    async () => () => { throw new Error("passage revoked") }), /policy-unqualified/)
  prepared.admission.release()
  assert.equal(prepared.admission.uncertain, false)
  await f.input.fence.run(physical, [physical], async () => {})
})

test("an asynchronous actual-effect fence is not synchronous authority", async () => {
  const f = await fixture()
  const prepared = await prepareMissionRootCreationLocation({ ...f.input, locations: [{ directory }], rootLocation: { directory },
    assertContract: async () => {}, operation: { key: "ordinary", workspaceID: "workspace", projectID,
      missionID: "mission", sessionID: "session", requestDigest: "digest" } })
  await assert.rejects(prepared.effect(async () => assert.fail("async fence must not create"),
    async () => async () => {}), /policy-unqualified/)
  prepared.admission.release()
  await f.input.fence.run(physical, [physical], async () => {})
})
