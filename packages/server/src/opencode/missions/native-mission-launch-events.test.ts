import assert from "node:assert/strict"
import test from "node:test"
import { missionConfigurationSchema, type MissionCondition } from "../../missions/launch-policy"
import { missionSourceKey, type MissionDocument } from "../../missions/mission-document"
import { prepareNativeDocumentSources } from "./native-scheduled-passage-sources"
import { assertMissionSourceAcyclic } from "./native-mission-condition-reader"
import type { MissionNativeService } from "./native-service-adapter"

const current = () => true as const
const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
const commits = { kind: "branch-commits" as const, directory: "/project", ref: "refs/heads/main" }
const files = { kind: "files-changed" as const, paths: ["package.json"] }
/** `when` then `onlyIf`, as one ordered list: an event below a schedule is a condition. */
function document(id: string, when: unknown[], onlyIf: unknown[] = []): MissionDocument {
  const configuration = missionConfigurationSchema.parse({ title: id, objective: "Work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } }, launch: { when: [...when, ...onlyIf] } })
  return { id, projectID: "project", projectCanonical: "/project", configuration, firstPlayedAt: 1, checkpoints: [], history: [], pending: null,
    oneTime: null } as unknown as MissionDocument
}
const roles = (snapshot: { news: { triggers: boolean; conditions: boolean } }) => ({ triggers: snapshot.news.triggers, conditions: snapshot.news.conditions })
const native = { location: { directory: "/project", project: { id: "project" } }, assertCurrent: current } as unknown as MissionNativeService

test("every listed event is read once by its own key; any change is enough within its role", async () => {
  const doc = document("target", [commits, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }], [files])
  let changed = new Set<string>()
  const reads: string[] = []
  const reader = async (_doc: MissionDocument, condition: MissionCondition) => {
    reads.push(condition.kind)
    return { checkpoint: { key: missionSourceKey(condition), kind: condition.kind, placementDigest: "a".repeat(64), value: { kind: condition.kind } },
      changed: changed.has(condition.kind), current }
  }
  const quiet = await prepareNativeDocumentSources(doc, native, new AbortController().signal, current, reader)
  assert.deepEqual(roles(quiet), { triggers: false, conditions: false }); assert.deepEqual(reads, ["branch-commits", "files-changed"])
  assert.deepEqual(quiet.checkpoints.map(item => item.kind).sort(), ["branch-commits", "files-changed"])
  changed = new Set(["files-changed"])
  assert.deepEqual(roles(await prepareNativeDocumentSources(doc, native, new AbortController().signal, current, reader)), { triggers: false, conditions: true },
    "a changed condition is reported apart from the trigger")
  changed = new Set(["branch-commits"])
  assert.deepEqual(roles(await prepareNativeDocumentSources(doc, native, new AbortController().signal, current, reader)), { triggers: true, conditions: false })
  const schedulesOnly = document("plain", [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }])
  assert.deepEqual(roles(await prepareNativeDocumentSources(schedulesOnly, native, new AbortController().signal, current)), { triggers: false, conditions: false },
    "a policy without events reports no news; its schedules trigger on their own")
})

test("each changed event is reported by its own key, so a schedule group reads only its own conditions", async () => {
  const doc = document("grouped", [commits, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }], [files])
  const reader = async (_doc: MissionDocument, condition: MissionCondition) => ({ checkpoint: { key: missionSourceKey(condition), kind: condition.kind,
    placementDigest: "a".repeat(64), value: { kind: condition.kind } }, changed: condition.kind === "files-changed", current })
  const snapshot = await prepareNativeDocumentSources(doc, native, new AbortController().signal, current, reader)
  assert.deepEqual(snapshot.news, { triggers: false, conditions: true, changed: [missionSourceKey(files)] })
})

test("Mission source edges are walked across every listed event, refusing a cycle through a second event", async () => {
  const documents = new Map<string, MissionDocument>([
    ["msn_a", document("msn_a", [files], [{ kind: "schedule-success", missionID: "msn_b" }])],
    ["msn_b", document("msn_b", [{ kind: "mission-completed", missionID: "msn_gone" }], [{ kind: "schedule-success", missionID: "msn_c" }])],
    ["msn_c", document("msn_c", [commits])],
  ])
  const store = { read: async (id: string) => documents.get(id) }
  const pinned: string[] = []
  await assertMissionSourceAcyclic(documents.get("msn_a")!, store, id => pinned.push(id))
  assert.deepEqual(pinned, ["msn_b", "msn_gone", "msn_c"])
  documents.set("msn_c", document("msn_c", [commits], [{ kind: "schedule-success", missionID: "msn_a" }]))
  await assert.rejects(assertMissionSourceAcyclic(documents.get("msn_a")!, store), /cycle/)
})
