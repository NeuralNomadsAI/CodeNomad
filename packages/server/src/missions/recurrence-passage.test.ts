import assert from "node:assert/strict"
import test from "node:test"
import { stableToken, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { recurrencePassage } from "./recurrence-passage"
import { recurrenceMessageID, recurrencePassageID, recurrenceCoordinatorSessionID, type RecurrenceDocument } from "./recurrence-contract"

function passageDocument() {
  const doc = {
    version: 1, projectID: "project", projectCanonical: "/owned/project", id: "daily_review",
    revision: 1, scheduleRevision: 0, createdAt: 1, state: "running",
    config: { title: "Review", template: "custom", consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
      profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", roots: [{ mode: "directory-only", directory: "/owned/project" }],
      watchedConversationIDs: [] },
    lastDaily: null, settledCount: 0, cursors: [], history: [], controls: [],
    pending: { passage: { id: "rcp_fixture", messageID: "msg_fixture", coordinatorSessionID: "ses_fixture", scheduleRevision: 0,
      due: { kind: "manual", requestID: "req_fixture", expectedRevision: 0, at: 1 }, createdAt: 1 }, admission: null },
  } as RecurrenceDocument
  // The codec refuses arbitrary passage IDs, so use the canonical reserved ID.
  doc.pending!.passage.id = recurrencePassageID(stableToken("project\0/owned/project", 24), doc.id, 0, doc.pending!.passage.due)
  doc.pending!.passage.messageID = recurrenceMessageID(doc.pending!.passage.id)
  doc.pending!.passage.coordinatorSessionID = recurrenceCoordinatorSessionID(doc.projectID, doc.pending!.passage.id, doc.pending!.passage.createdAt)
  return doc
}

test("passage journal isolates its exact key and repeats the publication fence", async () => {
  const values = new Map<string, MissionJsonValue>()
  let active = true
  let delay = false, entered!: () => void, release!: () => void
  const enteredWrite = new Promise<void>(resolve => { entered = resolve })
  const writeDelay = new Promise<void>(resolve => { release = resolve })
  const current = () => { if (!active) throw new Error("revoked"); return true as const }
  const storage: MissionStorage = {
    get: async key => values.get(key),
    set: async (key, value, fence) => {
      if (delay) { entered(); await writeDelay }
      fence?.(); values.set(key, value)
    },
    scan: async () => ({ entries: [] }),
  }
  const doc = passageDocument()
  const scope = recurrencePassage(storage, doc, current)
  await assert.rejects(scope.storage.get("codenomad-missions/authority-v2/namespace"), /scope conflict/)
  await assert.rejects(scope.journal.append({ version: 1, type: "mission.created", id: "evt_wrong", projectID: "project",
    missionID: "msn_foreign", projectCanonical: "/owned/project", objective: "Review", template: "custom",
    profiles: doc.config.profiles, taskMode: "native", coordinator: { sessionID: "ses_other", title: "Review",
      location: { directory: "/owned/project" } }, createdAt: 1 }), /scope conflict/)
  const ownedEvent = { version: 1 as const, type: "mission.created" as const, id: "evt_blocked", projectID: "project",
    missionID: scope.missionID, projectCanonical: "/owned/project", objective: "Review", template: "custom",
    profiles: doc.config.profiles, taskMode: "native", coordinator: { sessionID: "ses_owned", title: "Review",
      location: { directory: "/owned/project" } }, createdAt: 1 } as const
  delay = true
  const interruptedWrite = scope.journal.append({ ...ownedEvent, id: "evt_delayed" })
  await enteredWrite
  active = false; release()
  await assert.rejects(interruptedWrite, /revoked|policy-unqualified/)
  assert.equal(values.size, 0, "a revocation during storage preparation cannot publish")
  delay = false
  await assert.rejects(scope.journal.append(ownedEvent), /policy-unqualified/)
  assert.equal(values.size, 0)
})

test("passage journal reads its mission range like the whole isolated journal", async () => {
  const values = new Map<string, MissionJsonValue>()
  const prefixes: string[] = []
  const storage: MissionStorage = {
    get: async key => values.get(key),
    set: async (key, value, fence) => { fence?.(); values.set(key, value) },
    scan: async ({ prefix, after, limit = 100 }) => {
      prefixes.push(prefix)
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      return { entries: keys.map(key => ({ key, value: values.get(key)! })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
  }
  const doc = passageDocument()
  const scope = recurrencePassage(storage, doc, () => true)
  const base = { version: 1 as const, projectID: "project", missionID: scope.missionID }
  await scope.journal.append({ ...base, type: "mission.created", id: "evt_created", projectCanonical: "/owned/project", objective: "Review",
    template: "custom", profiles: doc.config.profiles, taskMode: "native", coordinator: { sessionID: scope.coordinatorSessionID, title: "Review",
      location: { directory: "/owned/project" } }, createdAt: 1 })
  // More than one scan page.
  for (let index = 0; index < 120; index++) await scope.journal.append({ ...base, type: "mission.updated", id: `evt_update_${String(index).padStart(3, "0")}`,
    requestID: `update-${index}`, expectedRevision: 1, notesSpecified: false, objective: `Review ${index}`, createdAt: 2 + index })
  const snapshot = await scope.journal.snapshot()
  prefixes.length = 0
  const view = await scope.journal.missionView(scope.missionID)
  assert.ok(prefixes.length > 1 && prefixes.every(prefix => prefix.endsWith(`/${scope.missionID}/`)), "the native scan stays on the mission's range")
  assert.deepEqual(view.mission, snapshot.missions[0])
  assert.equal(view.mission?.revision, 121)
  assert.deepEqual(view.events, (await scope.journal.events()).events)
  await assert.rejects(scope.journal.missionView(`msn_${"0".repeat(24)}`), /scan conflict/)
})
