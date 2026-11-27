import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "./journal"
import { MISSION_SCHEMA_VERSION, type MissionCreatedEvent, type MissionJsonValue } from "./model"

// Preserve serialized bytes, including whitespace, rather than normalizing seeds.
class SharedStorage implements MissionStorage {
  readonly bytes = new Map<string, string>()
  readonly reads: string[] = []
  readonly writes: string[] = []
  async get(key: string) {
    this.reads.push(key)
    const value = this.bytes.get(key)
    return value === undefined ? undefined : JSON.parse(value) as MissionJsonValue
  }
  async set(key: string, value: MissionJsonValue) {
    this.writes.push(key)
    this.bytes.set(key, JSON.stringify(value))
  }
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    this.reads.push(prefix)
    const keys = [...this.bytes.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
    const page = keys.slice(0, limit)
    return { entries: page.map(key => ({ key, value: JSON.parse(this.bytes.get(key)!) as MissionJsonValue })),
      ...(keys.length > limit ? { next: page[page.length - 1] } : {}) }
  }
}

const projectID = "project-isolation"
const canonical = "/owned/isolation"
const token = stableToken(`${projectID}\0${canonical}`, 24)
const legacyJournal = `codenomad-missions/v1/${token}`
const legacyAuthority = "codenomad-missions/authority-v1"
const created = (missionID: string, objective: string): MissionCreatedEvent => ({
  version: MISSION_SCHEMA_VERSION, type: "mission.created", id: "evt_created", projectID,
  projectCanonical: canonical, missionID, objective, template: "custom", requestID: "create-request", prepared: true,
  coordinator: { sessionID: "ses_fresh", title: "Fresh coordinator", location: { directory: canonical } }, createdAt: 1,
})
const entries = (storage: SharedStorage, prefix: string) => [...storage.bytes].filter(([key]) => key.startsWith(`${prefix}/`)).sort()
function seedLegacy(storage: SharedStorage) {
  storage.bytes.set(`${legacyJournal}/msn_legacy/evt_created`, JSON.stringify(created("msn_legacy", "Old map"), null, 2))
  storage.bytes.set(`${legacyAuthority}/namespace`, JSON.stringify(randomUUID()))
  storage.bytes.set(`${legacyAuthority}/project/${token}`, '{ "grants": ["old-active"], "receipts": ["old-receipt"], "migrations": [] }')
}

test("the journal never reads, imports, normalizes or deletes old-generation bytes", async () => {
  const storage = new SharedStorage(); seedLegacy(storage)
  const original = [...storage.bytes]
  const journal = new MissionJournal(storage, projectID, canonical, () => 100)
  assert.deepEqual((await journal.snapshot()).missions, [])
  assert.equal(await journal.event("msn_legacy", "evt_created"), undefined)
  assert.deepEqual([...storage.bytes], original, "journal reads must not write")
  await journal.append(created("msn_fresh", "Fresh map"))
  assert.equal((await journal.snapshot()).missions[0].id, "msn_fresh")
  for (const [key, bytes] of original) assert.equal(storage.bytes.get(key), bytes)
  assert.ok(storage.reads.every(key => !key.startsWith("codenomad-missions/v1/") && !key.startsWith("codenomad-missions/authority-")))
  assert.ok(storage.writes.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`)))
  assert.equal(MISSION_SCHEMA_VERSION, 1, "storage generations do not change wire schemas")
})

test("an old-key writer cannot change fresh maps or another project", async () => {
  const storage = new SharedStorage(); seedLegacy(storage)
  const journal = new MissionJournal(storage, projectID, canonical, () => 100)
  await journal.append(created("msn_fresh", "Fresh map"))
  const map = await journal.snapshot(), freshBytes = entries(storage, MISSION_JOURNAL_STORAGE_PREFIX)
  // A private legacy writer uses literal old keys, not a backwards-compatible constructor.
  await storage.set(`${legacyJournal}/msn_legacy/evt_late`, JSON.parse(JSON.stringify({ ...created("msn_legacy", "Old writer still works"), id: "evt_late" })))
  await storage.set(`${legacyAuthority}/project/${token}`, { grants: ["changed-old-grant"], receipts: ["changed-old-receipt"] })
  assert.ok(storage.bytes.has(`${legacyJournal}/msn_legacy/evt_late`))
  assert.deepEqual(await journal.snapshot(), map)
  assert.deepEqual(entries(storage, MISSION_JOURNAL_STORAGE_PREFIX), freshBytes)
  assert.deepEqual((await new MissionJournal(storage, "other-project", canonical).snapshot()).missions, [])
  assert.deepEqual((await new MissionJournal(storage, projectID, "/owned/other-canonical").snapshot()).missions, [])
})
