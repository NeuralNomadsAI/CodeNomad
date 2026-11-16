import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { NativeMissionDocumentStore } from "./mission-document-store"
import { missionScheduleID } from "./mission-schedule-contract"
import { missionScheduleView } from "./mission-schedule-view"
import { missionPreparationCreation, normalizedPreparationOptions } from "./preparation-input"
import { readMissionPreparationBinding } from "./creation-intent"
import { boundedInspection, inspectionContentValue, withinInspectBound } from "./inspect-view"
import { missionDocumentChanges } from "./mission-document-state"
import { recoveredScheduledPreparation } from "./scheduled-preparation"
import { resolveMissionCreationDefaults } from "./profile-defaults"
import { parsePrepareInput } from "../opencode/missions-plugin"
import type { MissionJsonValue } from "./model"
import type { MissionPrepareRequest } from "./control-types"

const directory = "C:/isolated-scheduled-preparation", author = "ses_author"
const selection = { agent: "build", model: { providerID: "test", id: "test-model" } }
const request = { requestID: "calendar", objective: "Isolated calendar", template: "custom" as const,
  profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const,
  launch: { when: [{ kind: "cron" as const, expression: "0 9 * * *", zone: "UTC" }] } }
function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: MissionJsonValue) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 1000 }: { prefix: string; after?: string; limit?: number }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b))
      const page = entries.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries: page, ...(entries.length > limit ? { next: page.at(-1)!.key } : {}) }
    },
    compareAndSet: async (key: string, value: MissionJsonValue, revision: number | null, current: () => true) => {
      current()
      assert.equal((values.get(key) as { revision?: number } | undefined)?.revision ?? null, revision)
      values.set(key, structuredClone(value))
    },
  }
  const store = new NativeMissionDocumentStore(storage, "project", directory), access = <T>(use: (store: NativeMissionDocumentStore) => Promise<T>) => use(store)
  let sends = 0, lose = false, beforeCreateLoss = false, preferenceReads = 0, preferred = selection, sourceMissionID: string | undefined
  const control = () => new MissionControl({ project: { id: "project", canonical: directory, location: { directory } }, storage,
    documents: access, documentReads: access,
    sessions: { get: async ({ sessionID }) => ({ id: sessionID, projectID: "project", location: { directory },
      ...(sourceMissionID ? { metadata: { "codenomad.mission": { missionID: sourceMissionID, kind: "coordinator" } } } : {}) }),
      create: async () => assert.fail("Scheduling creates no coordinator"), prompt: async () => assert.fail("No direct prompt"), synthetic: async () => assert.fail("No direct input") },
    transport: { prompt: async () => {}, synthetic: async () => {},
      resolveCreationDefaults: async (_id, input) => {
        preferenceReads++
        return resolveMissionCreationDefaults({ ...input, preferences: [{ template: "all",
          profiles: { coordinator: preferred, roles: { specialist: preferred } }, taskMode: "native" }] })
      },
      prepare: async (sessionID, input) => {
        const id = missionScheduleID("project", directory, input.requestID), options = normalizedPreparationOptions(input)
        if (input.observeOnly) {
          const document = await store.read(id)
          if (!document || "deletedAt" in document) throw new Error("Unavailable receipt")
          return recoveredScheduledPreparation(document)
        }
        sends++
        const creation = missionPreparationCreation(input, { coordinatorSessionID: sessionID,
          ...(input.missionID ? { missionID: input.missionID } : {}) }, input.requestID)
        assert.deepEqual(await readMissionPreparationBinding(storage, { id: "project", canonical: directory }, input.requestID),
          { author: creation.author, creationRequestID: input.requestID, creationDigest: creation.digest })
        if (beforeCreateLoss) throw new Error("Cut before Create")
        const doc = await store.create(id, { objective: input.objective, template: input.template, title: input.title ?? "Calendar", profiles: input.profiles, taskMode: input.taskMode,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }],
          watchedConversationIDs: options.watchedConversationIDs, launch: options.launch,
        } as never, Date.now(), () => true, null, creation)
        if (lose) throw new Error("ACK lost")
        return { outcome: "prepared", acknowledgement: "fresh", target: { kind: "schedule", document: missionScheduleView(doc) } }
      } },
  })
  return { control, store, values, get sends() { return sends }, lose: () => { lose = true },
    source: (value?: string) => { sourceMissionID = value },
    get preferenceReads() { return preferenceReads },
    beforeCreateLoss: (value: boolean) => { beforeCreateLoss = value },
    changePreferences: () => { preferred = { ...selection, model: { ...selection.model, id: "changed" } } } }
}

test("calendar preparation recovers without a journal or another dispatch, survives reconstruction and stays author-visible", async () => {
  const f = fixture(), first = await f.control().prepare(author, request)
  assert.equal(first.preparation.target?.kind, "schedule")
  assert.equal(first.preparation.outcome, "prepared")
  const document = first.preparation.target!.kind === "schedule" ? first.preparation.target!.document.document! : assert.fail()
  const rebuilt = f.control(), replay = await rebuilt.prepare(author, request)
  assert.equal(replay.preparation.outcome, "prepared")
  assert.equal("acknowledgement" in replay.preparation && replay.preparation.acknowledgement, "recovered")
  assert.equal(f.sends, 1)
  assert.equal((await rebuilt.inspect(author, { missionID: document.id }, "read")).schedule?.document?.id, document.id)
  assert.equal((await rebuilt.inspect("ses_other", { missionID: document.id }, "read")).schedule?.document?.id, document.id)
  assert.deepEqual((await rebuilt.listMissions(author)).map(item => item.missionID), [document.id])
  assert.deepEqual((await rebuilt.listMissions("ses_other")).map(item => item.missionID), [document.id])
  for (const changed of [{ launch: { when: [{ kind: "now" as const }] } }, { watchedConversationIDs: ["ses_source"] },
    { coordinatorSessionID: "ses_chosen" }, { startOnCreation: true }]) {
    await assert.rejects(rebuilt.prepare(author, { ...request, ...changed }), { code: "prepare-conflict" })
  }
})

test("a lost calendar ACK recovers the document instead of dispatching again", async () => {
  const f = fixture(); f.lose()
  await assert.rejects(f.control().prepare(author, request), { code: "prepare-uncertain" })
  const result = await f.control().prepare(author, request)
  assert.equal(result.preparation.outcome, "prepared")
  assert.equal(f.sends, 1)
})

test("calendar recovery keeps its source after marker cleanup, even when another source becomes current", async () => {
  const f = fixture()
  f.source("msn_passage")
  const first = await f.control().prepare(author, request)
  for (const source of [undefined, "msn_another_passage"]) {
    f.source(source)
    const replay = await f.control().prepare(author, request)
    assert.equal(replay.preparation.outcome, "prepared")
    assert.deepEqual(replay.preparation.target, first.preparation.target)
  }
  assert.equal(f.sends, 1)
  f.source()
  const separate = await f.control().prepare(author, { ...request, requestID: "after_release" })
  assert.equal(separate.preparation.target?.kind, "schedule")
  if (separate.preparation.target?.kind === "schedule")
    assert.deepEqual(separate.preparation.target.document.document?.creation?.author, { coordinatorSessionID: author })
  assert.equal(f.sends, 2, "the released root remains eligible for new preparations")
})

test("uncertain pre-document scheduling keeps its original identity after marker cleanup", async () => {
  const f = fixture()
  f.source("msn_passage"); f.beforeCreateLoss(true)
  let original: unknown
  await assert.rejects(f.control().prepare(author, request), (error: any) => {
    original = error.preparation
    return error.code === "prepare-uncertain"
  })
  f.source()
  await assert.rejects(f.control().prepare(author, request), (error: any) => {
    assert.deepEqual(error.preparation, original)
    return error.code === "prepare-uncertain"
  })
  assert.equal(f.sends, 1, "a changed source never redispatches an uncertain original")
})

test("uncertain pre-dispatch scheduling retains its resolved profiles across changed preferences and reconstruction", async () => {
  const f = fixture(), { profiles: _profiles, taskMode: _mode, ...input } = request
  f.beforeCreateLoss(true)
  await assert.rejects(f.control().prepare(author, input), { code: "prepare-uncertain" })
  f.changePreferences(); f.beforeCreateLoss(false)
  const result = await f.control().prepare(author, input)
  if (result.preparation.target?.kind !== "schedule") assert.fail()
  assert.deepEqual(result.preparation.target.document.document?.configuration.profiles, request.profiles)
  assert.equal(f.preferenceReads, 1)
  assert.equal(f.sends, 2)
})

test("authored scheduling lists page without duplicates and a deleted target is never recreated", async () => {
  const f = fixture(), ids: string[] = []
  for (let index = 0; index < 10; index++) {
    const result = await f.control().prepare(author, { ...request, requestID: `calendar_${index}` })
    if (result.preparation.target?.kind !== "schedule") assert.fail()
    ids.push(result.preparation.target.document.document!.id)
  }
  const listed = await f.control().listMissions(author)
  assert.equal(new Set(listed.map(item => item.missionID)).size, 10)
  assert.deepEqual(new Set(listed.map(item => item.missionID)), new Set(ids))
  const saved = await f.store.read(ids[0])
  if (!saved || "deletedAt" in saved) assert.fail()
  const stopped = await f.store.change(saved.id, saved.revision, () => true, value => {
    missionDocumentChanges.requestDeletion(value, "delete_calendar", Date.now(), { expectedRevision: value.revision, deleteManagedSessions: false })
    value.synchronization = null
  })
  await f.store.compact(stopped.id, stopped.revision, Date.now(), () => true)
  await assert.rejects(f.control().prepare(author, { ...request, requestID: "calendar_0" }), { code: "mission-deleted" })
  assert.equal(f.sends, 10)
  assert.equal((await f.control().listMissions(author)).length, 9)
})

test("prepare uses the shared ordered criteria codec and normalizes immediate selectors", () => {
  for (const launch of [undefined, { when: [] }, { when: [{ kind: "now" as const }] }])
    assert.equal(normalizedPreparationOptions({ launch }).kind, "one-time")
  const launch = { when: [{ kind: "files-changed", paths: ["src/a.ts"] }, request.launch.when[0],
    { kind: "conversation-message", conversationID: "ses_source" }, { kind: "now" }] }
  assert.deepEqual(parsePrepareInput({ ...request, launch }).launch, launch)
  assert.throws(() => parsePrepareInput({ ...request, launch: { when: [request.launch.when[0], request.launch.when[0]] } }))
  assert.throws(() => parsePrepareInput({ ...request, watchedConversationIDs: ["ses_source", "ses_source"] }))
})

for (const criterion of [
  { kind: "cron", expression: "0 */2 * * *", zone: "UTC" },
  { kind: "cron", expression: "0 9 * * 1,3", zone: "Europe/Paris" },
  { kind: "cron", expression: "0 9 15 * *", zone: "Asia/Tokyo" },
  { kind: "branch-commits", directory, ref: "refs/heads/main" },
  { kind: "conversation-message", conversationID: "ses_source" },
  { kind: "files-changed", paths: ["src/a.ts"] },
  { kind: "schedule-success", missionID: "msn_source" },
  { kind: "mission-completed", missionID: "msn_source" },
  { kind: "repository-activity", provider: "gitlab", host: "gitlab.com", repository: "group/repo", event: "pull-request-merged" },
  { kind: "github-notification" },
  { kind: "github-security-alert", repository: "owner/repo" },
  { kind: "github-pull-request", repository: "owner/repo", author: "author" },
  { kind: "github-issue", repository: "owner/repo" },
]) test(`prepare freezes shared launch criterion ${JSON.stringify(criterion)}`, async () => {
  const f = fixture(), input = parsePrepareInput({ ...request, launch: { when: [criterion] } })
  const result = await f.control().prepare(author, input)
  assert.equal(result.preparation.target?.kind, "schedule")
  if (result.preparation.target?.kind === "schedule")
    assert.deepEqual(result.preparation.target.document.document?.configuration.launch, input.launch)
  assert.equal((await f.control().prepare(author, input)).preparation.outcome, "prepared")
  assert.equal(f.sends, 1)
})

test("large authored schedule inspections reuse revision-bound content slices", async () => {
  const f = fixture(), result = await f.control().prepare(author, { ...request, objective: "a".repeat(20_000), notes: "b".repeat(20_000),
    launch: { when: [{ kind: "files-changed", paths: Array.from({ length: 60 }, (_, index) => `path_${index}_${"a".repeat(300)}`) }] } })
  if (result.preparation.target?.kind !== "schedule") assert.fail()
  const id = result.preparation.target.document.document!.id
  const inspection = await f.control().inspect(author, { missionID: id }, "read")
  const bounded = boundedInspection(inspection) as any
  assert.equal(withinInspectBound(bounded), true)
  assert.ok(bounded.schedule.read)
  const read = bounded.schedule.read.content
  assert.deepEqual(inspectionContentValue(inspection, read), inspection.schedule)
  const slice = await f.control().inspectTool(author, bounded.schedule.read, "read") as any
  assert.equal(slice.content.offset, 0)
  assert.equal(withinInspectBound(slice), true)
  assert.throws(() => inspectionContentValue(inspection, { ...read, revision: read.revision + 1 }), /changed/)
})
