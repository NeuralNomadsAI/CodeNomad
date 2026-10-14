import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "./journal"
import { reportInput } from "./inputs"
import { MISSION_MAX_EVENTS, reduceMissionEvents, type MissionEvent, type MissionJsonValue, type MissionMap } from "./model"
import type { NativeMissionSession } from "./control-types"
import { MissionNotificationOutbox } from "./notification-outbox"
import { controlResumeAdmissionID } from "./receipt-identity"

function fixture() {
  const values = new Map<string, MissionJsonValue>(), native = new Map<string, NativeMissionSession>()
  const location = { directory: "/owned/project" }
  for (const id of ["ses_coordinator", "ses_specialist", "ses_second"]) native.set(id, { id, projectID: "project", title: id, location })
  let writes = 0, controls = 0, synthetics = 0, prompts = 0, now = 1000
  let failControl = true, failNotification = true, failControlReceipt = false
  let duringControl: (() => void) | undefined, duringNotification: (() => void) | undefined
  const lifecycleIDs: string[] = [], messageIDs: string[] = []
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) {
      if (failControlReceipt && (value as any).type === "mission.control-applied") { failControlReceipt = false; throw new Error("lost control receipt") }
      writes++; values.set(key, structuredClone(value))
    },
    async scan({ prefix, after, limit = 100 }) {
      assert.equal(limit, 100)
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort(), page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })), ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const project = { id: "project", canonical: location.directory, location }
  const control = new MissionControl({ project, storage, now: () => now++, sessions: {
    get: async ({ sessionID }) => { const session = native.get(sessionID); if (!session) throw new Error("missing"); return structuredClone(session) },
    create: async () => { throw new Error("existing isolated roots only") }, prompt: async () => { throw new Error("bridge required") }, synthetic: async () => { throw new Error("bridge required") },
  }, transport: {
    prompt: async () => { prompts++ },
    lifecycle: async (_, input) => {
      controls++; lifecycleIDs.push(input.operationID); duringControl?.(); if (failControl) throw new Error("native control unavailable")
      const operation = (await journal.snapshot()).missions.find(mission => mission.id === input.missionID)?.control
      if (!operation || operation.id !== input.operationID) throw new Error("No fixture native operation")
      return { nativeAcknowledgement: operation.action === "start"
        ? { ...input, action: "start", disposition: "start-admitted", admission: {
          id: controlResumeAdmissionID(operation.id, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue",
          time: { created: now++ }, payload: { text: "Resume existing work", metadata: { "codenomad.mission": {
            version: 1, kind: "lifecycle", missionID: input.missionID, operationID: operation.id } } },
        } }
        : { ...input, action: operation.action, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
    },
    synthetic: async (_, input) => { synthetics++; messageIDs.push(input.id); duringNotification?.(); if (failNotification) throw new Error("notification not admitted") },
  } })
  const journal = new MissionJournal(storage, project.id, project.canonical)
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}`
  const key = (event: Pick<MissionEvent, "missionID" | "id">) => `${prefix}/${event.missionID}/${event.id}`
  const inject = (event: unknown, physicalKey = key(event as MissionEvent)) => { values.set(physicalKey, structuredClone(event) as MissionJsonValue); return physicalKey }
  const create = async (prepared = false, requestID = "create") => (await control.create({ requestID, objective: "Receipt fixture", template: "custom", coordinatorSessionID: "ses_coordinator", prepared })).mission
  const delegate = (mission: MissionMap, taskKey = "work", targetSessionID = "ses_specialist") => control.delegate(mission.coordinatorSessionId, {
    missionID: mission.id, taskKey, title: taskKey, brief: taskKey, role: "worker", blockedBy: [], delivery: "queue", targetSessionID,
  })
  const report = async (mission: MissionMap, taskKey = "work", sessionID = "ses_specialist") => (await control.report(sessionID, {
    missionID: mission.id, taskKey, outcome: "completed", summary: "Saved result", evidence: [], next: [], final: false,
  })).mission
  const counts = () => ({ writes, controls, synthetics, prompts })
  return { values, control, journal, key, inject, create, delegate, report, counts, lifecycleIDs, messageIDs,
    allowControl: () => { failControl = false }, allowNotifications: () => { failNotification = false },
    loseControlReceipt: () => { failControlReceipt = true },
    duringControl: (callback: () => void) => { duringControl = callback }, duringNotification: (callback: () => void) => { duringNotification = callback } }
}

async function pendingControl() {
  const f = fixture(), mission = await f.create(true)
  const request = { missionID: mission.id, requestID: "start", action: "start" as const, expectedRevision: mission.revision }
  await assert.rejects(f.control.lifecycle(request), (error: any) => error.code === "control-pending")
  const operation = (await f.journal.events()).events.find(event => event.type === "mission.control-requested")!
  assert.equal(operation.type, "mission.control-requested")
  if (operation.type !== "mission.control-requested") throw new Error("missing control")
  const receipt = { version: 1 as const, type: "mission.control-applied" as const,
    id: `evt_${stableToken(`${operation.id}\0applied\0${operation.targets[0].sessionID}`, 28)}`,
    projectID: mission.projectID, missionID: mission.id, operationID: operation.id, sessionID: operation.targets[0].sessionID, createdAt: 2000 }
  return { f, mission, request, operation, receipt }
}

for (const damage of ["noncanonical", "physical-key", "event", "mission", "project", "operation", "target", "kind", "orphan"] as const) {
  test(`lifecycle ${damage} receipt preserves original pending targets and denies exact/new retries without effects or repair`, async () => {
    const { f, mission, request, operation, receipt } = await pendingControl()
    let bad: any = { ...receipt }, key = f.key(receipt)
    if (damage === "noncanonical") { bad.id = "evt_noncanonical_ack"; key = f.key(bad) }
    if (damage === "physical-key") key = f.key({ ...receipt, id: "evt_wrong_key" })
    if (damage === "event") bad.id = "evt_wrong_value_id"
    if (damage === "mission") bad.missionID = "msn_other"
    if (damage === "project") bad.projectID = "foreign-project"
    if (damage === "operation" || damage === "orphan") {
      bad.operationID = "evt_other_operation"; bad.id = `evt_${stableToken(`${bad.operationID}\0applied\0${receipt.sessionID}`, 28)}`
      key = f.key(bad)
      if (damage === "operation") bad.id = receipt.id
    }
    if (damage === "target") { bad.sessionID = "ses_other"; bad.id = `evt_${stableToken(`${operation.id}\0applied\0${bad.sessionID}`, 28)}`; key = f.key(bad) }
    if (damage === "kind") bad = { ...bad, type: "report.notified", reportID: "rpt_other", admissionID: "msg_other" }
    f.inject(bad, key)
    const bytes = JSON.stringify(f.values.get(key)), before = f.counts(), snapshot = await f.control.snapshot(), projected = snapshot.missions[0]
    assert.equal((projected as any).controlUnavailable, true)
    assert.deepEqual(projected.control!.pending, operation.targets.map(target => target.sessionID))
    assert.equal(projected.control!.id, operation.id); assert.equal(projected.control!.requestID, request.requestID)
    await assert.rejects(f.journal.assertCanAppend(MISSION_MAX_EVENTS - f.values.size), /safety limit/)
    f.allowControl()
    await assert.rejects(f.control.lifecycle(request))
    await assert.rejects(f.control.lifecycle({ ...request, requestID: "new-stop", action: "stop", expectedRevision: projected.revision }))
    assert.deepEqual(f.counts(), before); assert.equal(JSON.stringify(f.values.get(key)), bytes)
    if (!["physical-key", "event", "mission", "project", "operation"].includes(damage)) {
      const raw = (await f.journal.events()).events
      assert.equal((reduceMissionEvents(raw).missions[0] as any).controlUnavailable, true)
    }
  })
}

test("lifecycle action/request/revision mismatch cannot reuse original control or call native effects", async () => {
  const { f, request, operation } = await pendingControl(), before = f.counts()
  for (const change of [{ action: "stop" as const }, { expectedRevision: request.expectedRevision + 1 }]) await assert.rejects(f.control.lifecycle({ ...request, ...change }))
  assert.deepEqual(f.counts(), before)
  assert.equal((await f.control.snapshot()).missions[0].control!.id, operation.id)
})

test("missing or lost ACK explicitly retries the stable original operation once; genuine success never replays", async () => {
  for (const lostPublication of [false, true]) {
    const f = fixture(), mission = await f.create(true)
    const request = { missionID: mission.id, requestID: "start", action: "start" as const, expectedRevision: mission.revision }
    if (lostPublication) { f.allowControl(); f.loseControlReceipt() }
    await assert.rejects(f.control.lifecycle(request))
    assert.equal(f.counts().controls, 1)
    const pending = (await f.control.snapshot()).missions[0]
    assert.equal((pending as any).controlUnavailable, undefined); assert.equal(pending.control!.pending.length, 1)
    f.allowControl()
    assert.deepEqual((await f.control.lifecycle(request)).mission.control!.pending, [])
    assert.equal(f.counts().controls, 2); assert.equal(f.lifecycleIDs[0], f.lifecycleIDs[1])
    const before = f.counts(); await f.control.lifecycle(request); assert.deepEqual(f.counts(), before)
  }
})

async function pendingReport() {
  const f = fixture(), mission = await f.create()
  await f.delegate(mission)
  const saved = await f.report(mission), report = saved.reports[0]
  assert.equal(report.notificationStatus, "pending"); assert.equal(f.counts().synthetics, 1)
  const receipt = { version: 1 as const, id: `evt_${stableToken(`${mission.id}\0report-${report.id}-notified`, 28)}`,
    type: "report.notified" as const, projectID: mission.projectID, missionID: mission.id, reportID: report.id,
    admissionID: reportInput(saved, report).id, createdAt: 2000 }
  return { f, mission, saved, report, receipt }
}

for (const damage of ["admission", "physical-key", "event", "mission", "project", "report", "kind", "orphan", "cross-report"] as const) {
  test(`notification ${damage} receipt remains pending/unavailable and recovery makes no synthetic call or repair`, async () => {
    const { f, mission, saved, report, receipt } = await pendingReport()
    let bad: any = { ...receipt }, key = f.key(receipt)
    if (damage === "admission") bad.admissionID = "msg_not_this_report"
    if (damage === "physical-key") key = f.key({ ...receipt, id: "evt_wrong_key" })
    if (damage === "event") bad.id = "evt_wrong_value_id"
    if (damage === "mission") bad.missionID = "msn_foreign"
    if (damage === "project") bad.projectID = "foreign-project"
    if (damage === "report") bad.reportID = "rpt_foreign"
    if (damage === "kind") bad = { ...bad, type: "mission.control-applied", operationID: "evt_orphan", sessionID: "ses_coordinator" }
    if (damage === "orphan") {
      bad.reportID = "rpt_orphan"; bad.admissionID = `msg_${stableToken(`report\0${bad.reportID}`, 28)}`
      bad.id = `evt_${stableToken(`${mission.id}\0report-${bad.reportID}-notified`, 28)}`; key = f.key(bad)
    }
    if (damage === "cross-report") {
      await f.delegate(saved, "second", "ses_second")
      const next = await f.report(saved, "second", "ses_second"), other = next.reports.find(item => item.id !== report.id)!
      bad.reportID = other.id; bad.admissionID = reportInput(next, other).id
    }
    f.inject(bad, key)
    const bytes = JSON.stringify(f.values.get(key)), before = f.counts(), snapshot = await f.control.snapshot(), projected = snapshot.missions[0]
    assert.equal((snapshot as any).notificationUnavailable, true)
    assert.equal((projected as any).notificationUnavailable, true)
    assert.equal(projected.reports.find(item => item.id === report.id)!.notificationStatus, "pending")
    f.allowNotifications()
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.control.retryPendingNotifications(), /notification.*unavailable|damaged/i)
    assert.deepEqual(f.counts(), before); assert.equal(JSON.stringify(f.values.get(key)), bytes)
    assert.equal((await f.control.snapshot()).missions[0].reports.find(item => item.id === report.id)!.notificationStatus, "pending")
  })
}

test("real report recovery uses the identical native message ID; admitted does not claim model consumption", async () => {
  const { f, report } = await pendingReport()
  f.allowNotifications()
  assert.equal((await f.control.snapshot()).missions[0].reports[0].notificationStatus, "pending")
  const retry = await f.control.retryPendingNotifications()
  assert.equal(retry.attempted, 1); assert.equal(retry.failed, 0); assert.equal(f.counts().synthetics, 2)
  assert.equal(f.messageIDs[0], f.messageIDs[1])
  const observed = (await f.control.snapshot()).missions[0].reports[0]
  assert.equal(observed.id, report.id); assert.equal(observed.notificationStatus, "admitted")
  assert.equal((observed as any).consumed, undefined)
  const before = f.counts(); assert.deepEqual(await f.control.retryPendingNotifications(), { attempted: 0, failed: 0 }); assert.deepEqual(f.counts(), before)
})

test("outbox treats damaged receipt recovery as failure and dispose fences subsequent passes without synthetic effects", async () => {
  const { f, receipt } = await pendingReport(); f.inject({ ...receipt, admissionID: "msg_wrong" })
  f.allowNotifications()
  let passObserved!: () => void, errors = 0
  const observed = new Promise<void>(resolve => { passObserved = resolve })
  const outbox = new MissionNotificationOutbox(`damaged-${receipt.missionID}`, async () => {
    try { return await f.control.retryPendingNotifications() }
    catch (error) { errors++; throw error }
    finally { passObserved() }
  }, 10)
  outbox.start(); await observed; outbox.dispose()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(errors, 1); assert.equal(f.counts().synthetics, 1)
})

test("damage introduced during real notification admission prevents receipt publication, not a fabricated rollback", async () => {
  const { f, receipt } = await pendingReport()
  f.allowNotifications()
  const bad = { ...receipt, admissionID: "msg_wrong" }, key = f.key(bad)
  f.duringNotification(() => f.inject(bad, key))
  const result = await f.control.retryPendingNotifications()
  assert.equal(result.failed, 1); assert.equal(f.counts().synthetics, 2)
  assert.equal(JSON.stringify(f.values.get(key)), JSON.stringify(bad))
  assert.equal((await f.control.snapshot()).missions[0].reports[0].notificationStatus, "pending")
  await assert.rejects(f.control.retryPendingNotifications())
  assert.equal(f.counts().synthetics, 2)
})

test("damage introduced during native control ACK prevents publication and future effects while retaining the original target", async () => {
  const { f, request, receipt, operation } = await pendingControl()
  f.allowControl()
  const bad = { ...receipt, id: "evt_noncanonical_during_ack" }, key = f.key(bad)
  f.duringControl(() => f.inject(bad, key))
  await assert.rejects(f.control.lifecycle(request))
  assert.equal(f.counts().controls, 2)
  const before = f.counts(), snapshot = await f.control.snapshot()
  assert.equal(snapshot.controlUnavailable, true)
  assert.deepEqual(snapshot.missions[0].control!.pending, operation.targets.map(target => target.sessionID))
  assert.equal(JSON.stringify(f.values.get(key)), JSON.stringify(bad))
  assert.equal(f.values.has(f.key(receipt)), false)
  await assert.rejects(f.control.lifecycle(request)); assert.deepEqual(f.counts(), before)
})

test("a valid per-target receipt settles only that target; corruption leaves the other target pending and blocks effects", async () => {
  const f = fixture(), mission = await f.create()
  await f.delegate(mission)
  const current = (await f.control.snapshot()).missions[0]
  const request = { missionID: current.id, requestID: "stop", action: "stop" as const, expectedRevision: current.revision }
  await assert.rejects(f.control.lifecycle(request))
  const operation = (await f.control.snapshot()).missions[0].control!, projectID = mission.projectID
  const receipt = (sessionID: string): MissionEvent => ({ version: 1, type: "mission.control-applied", projectID, missionID: mission.id,
    id: `evt_${stableToken(`${operation.id}\0applied\0${sessionID}`, 28)}`, operationID: operation.id, sessionID, createdAt: 2000 })
  await f.journal.append(receipt(operation.targets[0].sessionID))
  const other = operation.targets[1].sessionID, bad = { ...receipt(other), id: "evt_bad_other_target" }, key = f.inject(bad)
  const observed = (await f.control.snapshot()).missions[0]
  assert.equal(observed.status, "stopped"); assert.deepEqual(observed.control!.pending, [other])
  assert.equal(observed.controlUnavailable, true)
  const before = f.counts(); f.allowControl(); await assert.rejects(f.control.lifecycle(request))
  assert.deepEqual(f.counts(), before); assert.equal(JSON.stringify(f.values.get(key)), JSON.stringify(bad))
})

test("late valid reports cannot wake execution or notification recovery after terminal Stop", async () => {
  const f = fixture(), mission = await f.create()
  await f.delegate(mission)
  f.allowControl(); f.allowNotifications()
  const active = (await f.control.snapshot()).missions[0]
  await f.control.lifecycle({ missionID: mission.id, requestID: "stop", action: "stop", expectedRevision: active.revision })
  const before = f.counts(), saved = await f.report(mission)
  assert.equal(saved.status, "stopped"); assert.equal(saved.reports[0].late, true)
  assert.equal(saved.reports[0].notificationStatus, "pending")
  assert.equal(f.counts().prompts, before.prompts); assert.equal(f.counts().synthetics, before.synthetics)
  const report = saved.reports[0]
  await f.journal.append({ version: 1, type: "report.notified", projectID: mission.projectID, missionID: mission.id,
    id: `evt_${stableToken(`${mission.id}\0report-${report.id}-notified`, 28)}`, reportID: report.id,
    admissionID: reportInput(saved, report).id, createdAt: 2000 })
  const observed = (await f.control.snapshot()).missions[0]
  assert.equal(observed.status, "stopped"); assert.equal(observed.reports[0].notificationStatus, "admitted")
  assert.equal(observed.notificationUnavailable, undefined)
  const counts = f.counts(); assert.deepEqual(await f.control.retryPendingNotifications(), { attempted: 0, failed: 0 })
  assert.deepEqual(f.counts(), counts)
})

test("direct bounded reducer cannot settle foreign-project control or wrong-message notification receipts", async () => {
  const lifecycle = await pendingControl(), controlEvents = (await lifecycle.f.journal.events()).events
  const control = reduceMissionEvents([...controlEvents, { ...lifecycle.receipt, projectID: "foreign-project" }])
  assert.equal(control.controlUnavailable, true)
  assert.equal(control.missions[0].controlUnavailable, true)
  assert.deepEqual(control.missions[0].control!.pending, lifecycle.operation.targets.map(target => target.sessionID))
  const notification = await pendingReport(), reportEvents = (await notification.f.journal.events()).events
  for (const bad of [{ ...notification.receipt, admissionID: "msg_wrong" }, { ...notification.receipt, projectID: "foreign-project" }]) {
    const result = reduceMissionEvents([...reportEvents, bad])
    assert.equal(result.notificationUnavailable, true)
    assert.equal(result.missions[0].reports[0].notificationStatus, "pending")
  }
})
