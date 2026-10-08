import assert from "node:assert/strict"
import test from "node:test"
import { stableToken, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { recurrencePassage } from "./recurrence-passage"
import { recurrenceMessageID, recurrencePassageID, type RecurrenceDocument } from "./recurrence-contract"

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
  const doc = {
    version: 1, projectID: "project", projectCanonical: "/owned/project", id: "daily_review",
    revision: 1, scheduleRevision: 0, createdAt: 1, state: "running",
    config: { consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
      profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", roots: [{ mode: "directory-only", directory: "/owned/project" }],
      watchedConversationIDs: [], publication: { policy: "draft-only", conversationIDs: [] } },
    lastDaily: null, settledCount: 0, cursors: [], history: [],
    pending: { passage: { id: "rcp_fixture", messageID: "msg_fixture", scheduleRevision: 0,
      due: { kind: "manual", requestID: "req_fixture", expectedRevision: 0, at: 1 }, createdAt: 1 }, admission: null },
  } as RecurrenceDocument
  // The codec refuses arbitrary passage IDs, so use the canonical reserved ID.
  doc.pending!.passage.id = recurrencePassageID(stableToken("project\0/owned/project", 24), doc.id, 0, doc.pending!.passage.due)
  doc.pending!.passage.messageID = recurrenceMessageID(doc.pending!.passage.id)
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
