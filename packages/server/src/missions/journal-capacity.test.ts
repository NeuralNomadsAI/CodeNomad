import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, stableToken, type MissionStorage } from "./journal"
import { cleanupReceiptID } from "./cleanup-projection"
import { MISSION_MAX_ACTORS, MISSION_MAX_EVENTS, type MissionEvent, type MissionJsonValue } from "./model"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  let writes = 0, scans = 0
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { writes++; values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      scans++; assert.equal(limit, 100, "retain the bounded native scan page size")
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const journal = new MissionJournal(storage, "project", "/owned/project")
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}`
  const base = { version: 1 as const, projectID: "project", missionID: "msn_owned", createdAt: 1 }
  const eventKey = (event: MissionEvent) => `${prefix}/${event.missionID}/${event.id}`
  const seed = (event: MissionEvent) => { assert(parseMissionEvent(event)); values.set(eventKey(event), structuredClone(event) as unknown as MissionJsonValue) }
  const ordinary = (id = "evt_extra"): MissionEvent => ({ ...base, id, type: "mission.updated", requestID: id,
    expectedRevision: 1, notesSpecified: false, objective: "unrelated update" })
  const fillTo = (size: number) => { for (let i = values.size; values.size < size; i++) seed(ordinary(`evt_filler_${i}`)) }
  const deletion = (missionID = base.missionID, id = "evt_deleted", targets = ["ses_owned"]): Extract<MissionEvent, { type: "mission.deleted" }> => ({
    ...base, missionID, id, type: "mission.deleted", requestID: "delete-request", expectedRevision: 1, deleteManagedSessions: true,
    cleanupTargets: targets.map(sessionID => ({ sessionID, location: { directory: "/owned/project" } })),
  })
  const receipt = (intent: ReturnType<typeof deletion>, sessionID = intent.cleanupTargets![0].sessionID): MissionEvent => ({
    ...base, missionID: intent.missionID, id: cleanupReceiptID(intent.id, sessionID), type: "mission.session-cleaned",
    deletionID: intent.id, sessionID, outcome: "removed",
  })
  const control = (missionID = base.missionID, id = "evt_control", targets = ["ses_owned"]): Extract<MissionEvent, { type: "mission.control-requested" }> => ({
    ...base, missionID, id, type: "mission.control-requested", requestID: "stop-request", expectedRevision: 1, action: "stop",
    targets: targets.map(sessionID => ({ sessionID, location: { directory: "/owned/project" } })),
  })
  const applied = (intent: ReturnType<typeof control>, sessionID = intent.targets[0].sessionID): MissionEvent => ({
    ...base, missionID: intent.missionID, id: `evt_${stableToken(`${intent.id}\0applied\0${sessionID}`, 28)}`,
    type: "mission.control-applied", operationID: intent.id, sessionID,
  })
  return { journal, values, prefix, base, eventKey, seed, ordinary, fillTo, deletion, receipt, control, applied,
    counts: () => ({ writes, scans }) }
}

const damageCases = ["original-foreign-miskeyed", "project", "mission", "key", "alternate-event-id", "foreign-orphan", "deletion", "session", "type", "wrong-kind", "malformed"] as const
for (const damage of damageCases) {
  test(`cleanup capacity: ${damage} receipt counts physically but cannot discharge the reserved target`, async () => {
    const f = fixture(); f.fillTo(MISSION_MAX_EVENTS - 3)
    const intent = f.deletion(); await f.journal.append(intent)
    const genuine = f.receipt(intent)
    // Deliberately damaged raw storage is not a typed MissionEvent.
    let event: unknown = { ...genuine, id: "evt_bad_receipt" }
    let key = `${f.prefix}/${f.base.missionID}/evt_bad_receipt`
    if (damage === "original-foreign-miskeyed") {
      event = { ...genuine, id: "evt_mismatched", missionID: "msn_other" }
      key = `${f.prefix}/msn_owned/evt_receipt_actual`
    } else if (damage === "project") event = { ...(event as Record<string, unknown>), projectID: "foreign-project" }
    else if (damage === "mission") event = { ...(event as Record<string, unknown>), missionID: "msn_other" }
    else if (damage === "key") { event = genuine; key = `${f.prefix}/msn_owned/evt_wrong_physical_key` }
    else if (damage === "foreign-orphan") { event = { ...genuine, missionID: "msn_other" }; key = `${f.prefix}/msn_other/${genuine.id}` }
    else if (damage === "deletion") event = { ...genuine, id: cleanupReceiptID("evt_orphan", "ses_owned"), deletionID: "evt_orphan" } as MissionEvent
    else if (damage === "session") event = { ...genuine, id: cleanupReceiptID(intent.id, "ses_other"), sessionID: "ses_other" } as MissionEvent
    else if (damage === "type") event = { ...f.base, id: "evt_bad_receipt", type: "task.dispatched", taskKey: "worker" }
    else if (damage === "wrong-kind") event = f.applied(f.control(f.base.missionID, intent.id))
    else if (damage === "malformed") event = { ...genuine, id: "evt_bad_receipt", outcome: "unknown" }
    if (["deletion", "session", "wrong-kind"].includes(damage)) key = f.eventKey(event as MissionEvent)
    f.values.set(key, structuredClone(event) as unknown as MissionJsonValue)
    const foreignBytes = JSON.stringify(f.values.get(key)), writes = f.counts().writes
    assert.equal(f.values.size, 1999)
    const observation = await f.journal.events()
    if (["original-foreign-miskeyed", "project", "mission", "key", "malformed"].includes(damage)) {
      assert.equal(observation.discardedEvents, 1)
      const segments = key.split("/")
      await assert.rejects(f.journal.event(segments.at(-2)!, segments.at(-1)!), /identity mismatch/)
    }
    await assert.rejects(f.journal.assertCanAppend(), /2000-event safety limit/)
    await assert.rejects(f.journal.append(f.ordinary()), /2000-event safety limit/)
    assert.equal(f.counts().writes, writes)
    assert.equal(f.values.size, 1999)
    // Low-level capacity does not authorize actual cleanup through a damaged
    // observation. Existing control/bridge regressions independently deny it.
    await f.journal.append(genuine)
    assert.equal(f.values.size, 2000); assert.equal(f.counts().writes, writes + 1)
    assert.equal(JSON.stringify(f.values.get(key)), foreignBytes)
    await f.journal.append(genuine) // exact durable append remains idempotent
    await assert.rejects(f.journal.append(f.ordinary()), /2000-event safety limit/)
  })
}

for (const damage of ["project", "mission", "key", "alternate-event-id", "foreign-orphan", "operation", "session", "wrong-kind"] as const) {
  test(`control capacity: ${damage} receipt cannot discharge a different/native target slot`, async () => {
    const f = fixture(); f.fillTo(1997)
    const intent = f.control(); await f.journal.append(intent)
    const genuine = f.applied(intent)
    let event: MissionEvent = { ...genuine, id: "evt_bad_control_receipt" }
    let key = f.eventKey(event)
    if (damage === "project") event = { ...event, projectID: "foreign-project" }
    else if (damage === "mission") event = { ...event, missionID: "msn_foreign" }
    else if (damage === "key") { event = genuine; key = `${f.prefix}/msn_owned/evt_wrong_physical_key` }
    else if (damage === "foreign-orphan") { event = { ...genuine, missionID: "msn_foreign" }; key = f.eventKey(event) }
    else if (damage === "operation") { event = f.applied(f.control(f.base.missionID, "evt_orphan")); key = f.eventKey(event) }
    else if (damage === "session") { event = f.applied(intent, "ses_other"); key = f.eventKey(event) }
    else if (damage === "wrong-kind") { event = f.receipt(f.deletion(f.base.missionID, intent.id)); key = f.eventKey(event) }
    f.values.set(key, structuredClone(event) as unknown as MissionJsonValue)
    const badBytes = JSON.stringify(f.values.get(key))
    await assert.rejects(f.journal.append(f.ordinary()), /2000-event safety limit/)
    await f.journal.append(genuine)
    assert.equal(f.values.size, 2000); assert.equal(JSON.stringify(f.values.get(key)), badBytes)
  })
}

test("invalid physical intent cannot establish reservation or supersede the latest valid native control", async () => {
  for (const kind of ["cleanup", "control"] as const) {
    const f = fixture(); f.fillTo(1998)
    const invalid = kind === "cleanup" ? f.deletion() : f.control()
    f.values.set(`${f.prefix}/msn_foreign/${invalid.id}`, invalid as unknown as MissionJsonValue)
    assert.equal((await f.journal.events()).discardedEvents, 1)
    await f.journal.append(f.ordinary()); assert.equal(f.values.size, 2000)
  }
  const f = fixture(); f.fillTo(1997)
  const valid = f.control(); await f.journal.append(valid)
  const invalid = { ...f.control(f.base.missionID, "evt_corrupt_control", ["ses_other"]), createdAt: 2 }
  f.values.set(`${f.prefix}/msn_wrong/${invalid.id}`, invalid as unknown as MissionJsonValue)
  await assert.rejects(f.journal.append(f.ordinary()), /2000-event safety limit/)
  await f.journal.append(f.applied(valid)); assert.equal(f.values.size, 2000)
})

test("occupied deterministic receipt key remains a collision, never a repair or permission to use reserved capacity", async () => {
  const f = fixture(); f.fillTo(1997)
  const intent = f.deletion(); await f.journal.append(intent)
  const receipt = f.receipt(intent), key = f.eventKey(receipt)
  const foreign = { ...receipt, projectID: "foreign-project" }
  f.values.set(key, foreign as unknown as MissionJsonValue)
  const bytes = JSON.stringify(f.values.get(key)), writes = f.counts().writes
  await assert.rejects(f.journal.append(f.ordinary()), /safety limit/)
  await assert.rejects(f.journal.append(receipt), /identity collision/)
  assert.equal(f.counts().writes, writes); assert.equal(JSON.stringify(f.values.get(key)), bytes)
})

test("reservations correlate mission/type/original target despite repeated intent IDs and display truncation", async () => {
  const f = fixture()
  const intents = []
  for (let index = 0; index < 25; index++) {
    const missionID = `msn_historical_${index}`
    f.seed({ ...f.base, missionID, id: "evt_created", type: "mission.created", projectCanonical: "/owned/project",
      objective: "Historical", template: "custom", coordinator: { sessionID: `ses_coordinator_${index}`, title: "Coordinator", location: { directory: "/owned/project" } } })
    const intent = index % 2 ? f.deletion(missionID, "evt_same_intent") : f.control(missionID, "evt_same_intent")
    await f.journal.append(intent); intents.push(intent)
  }
  for (let index = 0; index < 25; index++) f.seed({ ...f.base, missionID: `msn_newer_${index}`, id: "evt_created",
    type: "mission.created", projectCanonical: "/owned/project", objective: "Newer", template: "custom", createdAt: 100 + index,
    coordinator: { sessionID: `ses_newer_${index}`, title: "Coordinator", location: { directory: "/owned/project" } } })
  const snapshot = await f.journal.snapshot()
  assert.equal(snapshot.missions.length, 20)
  assert(snapshot.discardedEvents > 0, "real display truncation does not truncate the capacity scan")
  assert.equal(snapshot.cleanupUnavailable, undefined)
  f.fillTo(2000 - intents.length)
  for (const intent of intents) {
    await assert.rejects(f.journal.append(f.ordinary()), /safety limit/)
    await f.journal.append(intent.type === "mission.deleted" ? f.receipt(intent) : f.applied(intent))
  }
  assert.equal(f.values.size, 2000)
  assert.equal((await f.journal.events()).events.length, 2000)
  await assert.rejects(f.journal.append(f.ordinary()), /safety limit/)
})

test("every bounded cleanup target retains its own slot up to the 2000-event physical limit", async () => {
  const f = fixture(), targets = Array.from({ length: MISSION_MAX_ACTORS }, (_, i) => `ses_target_${i}`)
  f.fillTo(2000 - targets.length - 1)
  const intent = f.deletion(f.base.missionID, "evt_multi_delete", targets)
  await f.journal.append(intent)
  for (const target of targets) {
    await assert.rejects(f.journal.append(f.ordinary()), /safety limit/)
    await f.journal.append(f.receipt(intent, target))
  }
  assert.equal(f.values.size, 2000)
  await f.journal.assertCanAppend(0)
  await f.journal.append(f.receipt(intent, targets[0]))
  await assert.rejects(f.journal.assertCanAppend(), /safety limit/)
  f.values.set(`${f.prefix}/msn_owned/evt_2001`, f.ordinary("evt_2001") as unknown as MissionJsonValue)
  await assert.rejects(f.journal.events(), /exceeds the 2000-event safety limit/)
  await assert.rejects(f.journal.assertCanAppend(), /exceeds the 2000-event safety limit/)
})

test("legitimate retained cleanup receipts discharge only their exact declared target", async () => {
  const f = fixture(); f.fillTo(1997)
  const intent = f.deletion(f.base.missionID, "evt_retained", ["ses_one", "ses_two"])
  await f.journal.append(intent)
  await f.journal.append({ ...f.receipt(intent, "ses_one"), outcome: "retained", reason: "shared" } as MissionEvent)
  await assert.rejects(f.journal.append(f.ordinary()), /safety limit/)
  await f.journal.append({ ...f.receipt(intent, "ses_two"), outcome: "retained", reason: "children" } as MissionEvent)
  assert.equal(f.values.size, 2000)
  await f.journal.assertCanAppend(0)
})

test("prospective Stop preflight and append replace only the superseded control reservation", async () => {
  const f = fixture(); f.fillTo(1997)
  const pause = { ...f.control(), action: "pause" as const }
  await f.journal.append(pause)
  const stop = { ...f.control(f.base.missionID, "evt_stop"), createdAt: 2, expectedRevision: 2 }
  await f.journal.assertCanAppend(stop)
  await f.journal.append(stop)
  assert.equal(f.values.size, 1999)
  await assert.rejects(f.journal.append(f.applied(pause)), /safety limit/, "an old receipt cannot consume the new Stop's slot")
  await f.journal.append(f.applied(stop))
  assert.equal(f.values.size, 2000)
  await f.journal.assertCanAppend(0)
  const writes = f.counts().writes
  await f.journal.append(stop)
  assert.equal(f.counts().writes, writes, "the original intent replay writes nothing")
})

test("prospective control credit cannot waive ordering, revision, scope or real receipt capacity", async () => {
  for (const fault of ["project", "mission", "time", "tie-order", "revision", "nonterminal", "old-stop", "extra-target"] as const) {
    const f = fixture(); f.fillTo(1997)
    const previous = { ...f.control(), action: fault === "old-stop" ? "stop" as const : "pause" as const }
    await f.journal.append(previous)
    const stop = { ...f.control(f.base.missionID, "evt_stop"), createdAt: 2, expectedRevision: 2 }
    if (fault === "project") stop.projectID = "foreign-project"
    if (fault === "mission") stop.missionID = "msn_other"
    if (fault === "time") stop.createdAt = 0
    if (fault === "tie-order") { stop.createdAt = previous.createdAt; stop.id = "evt_aaa" }
    if (fault === "revision") stop.expectedRevision = previous.expectedRevision
    if (fault === "nonterminal") stop.action = "pause"
    if (fault === "extra-target") stop.targets.push({ sessionID: "ses_other", location: { directory: "/owned/project" } })
    const bytes = structuredClone([...f.values]), writes = f.counts().writes
    await assert.rejects(f.journal.assertCanAppend(stop), /safety limit|durable|another project/, fault)
    await assert.rejects(f.journal.append(stop), /safety limit|durable|another project/, fault)
    assert.deepEqual([...f.values], bytes, fault)
    assert.equal(f.counts().writes, writes, fault)
  }
})

test("Stop leaves cleanup and other-mission control reservations intact", async () => {
  const f = fixture(); f.fillTo(1994)
  const pause = { ...f.control(), action: "pause" as const }
  await f.journal.append(pause)
  await f.journal.append(f.deletion())
  await f.journal.append({ ...f.control("msn_other", "evt_other_control"), action: "pause" })
  const stop = { ...f.control(f.base.missionID, "evt_stop"), createdAt: 2, expectedRevision: 2 }
  const bytes = structuredClone([...f.values])
  await assert.rejects(f.journal.assertCanAppend(stop), /safety limit/)
  await assert.rejects(f.journal.append(stop), /safety limit/)
  assert.deepEqual([...f.values], bytes)
})

test("append rechecks prospective Stop capacity after an earlier preflight", async () => {
  const f = fixture(); f.fillTo(1997)
  await f.journal.append({ ...f.control(), action: "pause" })
  const stop = { ...f.control(f.base.missionID, "evt_stop"), createdAt: 2, expectedRevision: 2 }
  await f.journal.assertCanAppend(stop)
  await f.journal.append(f.ordinary())
  const bytes = structuredClone([...f.values])
  await assert.rejects(f.journal.append(stop), /safety limit/)
  assert.deepEqual([...f.values], bytes)
})

for (const [pauseID, stopID, newer] of [["evt_Z", "evt_a", false], ["evt_a", "evt_Z", true]] as const) {
  test(`equal-timestamp Stop ${stopID} uses reconstruction's ordering relative to Pause ${pauseID}`, async () => {
    const f = fixture()
    f.seed({ ...f.base, id: "evt_created", type: "mission.created", projectCanonical: "/owned/project",
      objective: "Fixture", template: "custom", coordinator: { sessionID: "ses_owned", title: "Coordinator", location: { directory: "/owned/project" } } })
    f.fillTo(1997)
    const pause = { ...f.control(f.base.missionID, pauseID), action: "pause" as const, createdAt: 2 }
    await f.journal.append(pause)
    const stop = { ...f.control(f.base.missionID, stopID), createdAt: 2, expectedRevision: 2 }
    if (!newer) {
      const bytes = structuredClone([...f.values])
      await assert.rejects(f.journal.assertCanAppend(stop), /safety limit/)
      await assert.rejects(f.journal.append(stop), /safety limit/)
      assert.deepEqual([...f.values], bytes)
      return
    }
    await f.journal.assertCanAppend(stop)
    await f.journal.append(stop)
    assert.equal((await f.journal.snapshot()).missions[0].control?.id, stopID)
    await f.journal.append(f.applied(stop))
    assert.deepEqual((await f.journal.snapshot()).missions[0].control?.pending, [])
    assert.equal(f.values.size, 2000)
    await f.journal.assertCanAppend(0)
  })
}
