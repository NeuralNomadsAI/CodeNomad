import assert from "node:assert/strict"
import test from "node:test"
import type { MissionDeleteInput } from "./control-types"
import { MissionJournal } from "./journal"
import { MissionJournalIndex, missionJournalWrites, type MissionIndexReader, type MissionReferenceKind } from "./journal-index"
import { cleanupReference, orderMissionCleanups, projectMissionCleanups } from "./cleanup-projection"
import type { MissionEvent, MissionMap, MissionSnapshot } from "./model"
import { hasUnsettledNativeExecution } from "./native-call-observation"
import { isCoordinatorNotificationReport } from "./native-report-provenance"
import { missionWorkRemains } from "../opencode/missions/lifetime"
import { fixture, seedCrossMission, step, type HistoryFixture } from "./journal-history-fixture"

// `shared` and `settledBeyondHistory` come from the deterministic cross-mission test.
const coverage = { purged: 0, interrupted: 0, activations: 0, foreign: 0, failed: 0, unconfirmed: 0, ties: 0, damaged: 0, open: 0, shared: 0, settledBeyondHistory: 0 }
const RANDOM_COVERAGE = ["purged", "interrupted", "activations", "foreign", "failed", "unconfirmed", "ties", "damaged", "open"] as const

function capture(index: MissionIndexReader, sessions: readonly string[]) {
  return { aggregate: index.aggregate(), open: index.openIDs(), cleanups: index.cleanups(), allCleanups: index.cleanups(Infinity),
    refs: new Map(sessions.map(sessionID => [sessionID, index.refs(sessionID)])) }
}

/** Mission work by the map alone, without project damage stamped on it. */
function mapWork(mission: MissionMap): boolean {
  return mission.status === "active" || Boolean(mission.control?.pending.length)
    || mission.tasks.some(task => task.outstandingExecution || hasUnsettledNativeExecution(task))
    || mission.reports.some(report => isCoordinatorNotificationReport(report) && report.notificationStatus === "pending")
}

/** Every index answer equals what the full `snapshot()`/`events()` derive. */
async function assertIndexed(f: HistoryFixture, label: string, rebuild: boolean) {
  const snapshot = await f.journal.snapshot(), { events } = await f.journal.events()
  // Oracle references straight from the full event list.
  const expected = new Map<string, Map<string, Set<MissionReferenceKind>>>()
  const add = (sessionID: string, missionID: string, kind: MissionReferenceKind) => {
    const missions = expected.get(sessionID) ?? new Map<string, Set<MissionReferenceKind>>()
    missions.set(missionID, (missions.get(missionID) ?? new Set()).add(kind))
    expected.set(sessionID, missions)
  }
  for (const event of events) {
    if (event.type === "mission.created") {
      add(event.coordinator.sessionID, event.missionID, "coordinator")
      if (event.preparedBy) add(event.preparedBy.coordinatorSessionID, event.missionID, "prepared-by")
    } else if (event.type === "task.dispatching") add(event.actor.sessionID, event.missionID, "dispatching")
    else if (event.type === "task.native-bound") add(event.actor.sessionID, event.missionID, "native-bound")
  }
  const sessions = [...expected.keys(), ...snapshot.missions.flatMap(mission => mission.actors.map(actor => actor.sessionId)), "ses_unknown"]
  const scans = f.fullScans()
  const read = await f.journal.readIndex(index => capture(index, sessions))
  // Writes this activation made refresh their missions; only a new activation or a foreign writer rescans.
  assert.equal(f.fullScans() > scans, rebuild, `${label}: full scan`)

  const order = snapshot.missions.map(mission => mission.id)
  for (const sessionID of sessions) {
    const missions = expected.get(sessionID) ?? new Map()
    const live = order.filter(id => missions.has(id))
    const rest = [...missions.keys()].filter(id => !live.includes(id)).sort((left, right) => `${left}/` < `${right}/` ? -1 : 1)
    assert.deepEqual(read.refs.get(sessionID), [...live, ...rest].map(missionID => ({ missionID,
      kinds: (["coordinator", "prepared-by", "dispatching", "native-bound"] as const).filter(kind => missions.get(missionID)!.has(kind)) })), `${label}: refs ${sessionID}`)
    if (missions.size > 1) coverage.shared++
    // Membership (`MissionControl.membership`) from the nominated candidates alone.
    const member = (mission: MissionMap) => mission.actors.some(actor => actor.sessionId === sessionID)
    const candidates = read.refs.get(sessionID)!.flatMap(ref => snapshot.missions.filter(mission => mission.id === ref.missionID))
    assert.equal(candidates.find(mission => mission.status === "active" && member(mission)) ?? candidates.find(member),
      snapshot.missions.find(mission => mission.status === "active" && member(mission)) ?? snapshot.missions.find(member), `${label}: membership ${sessionID}`)
    for (const mission of new Set(events.map(event => event.missionID))) {
      // `referencedElsewhere`: shared-session cleanup evidence.
      assert.equal(read.refs.get(sessionID)!.some(ref => ref.missionID !== mission && ref.kinds.some(kind => kind === "coordinator" || kind === "dispatching")),
        events.some(event => event.missionID !== mission && cleanupReference(event) === sessionID), `${label}: shared ${sessionID} ${mission}`)
    }
  }
  // A superset of every map's members and hand-off authors.
  for (const mission of snapshot.missions) {
    for (const sessionID of [...mission.actors.map(actor => actor.sessionId), ...mission.preparedBy ? [mission.preparedBy.coordinatorSessionId] : []]) {
      assert.ok(read.refs.get(sessionID)?.some(ref => ref.missionID === mission.id), `${label}: ${sessionID} nominates ${mission.id}`)
    }
  }
  for (let index = 1; index < snapshot.missions.length; index++) if (snapshot.missions[index].updatedAt === snapshot.missions[index - 1].updatedAt) coverage.ties++

  const damaged = Boolean(snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable)
  if (damaged) coverage.damaged++
  assert.deepEqual(read.aggregate, { discardedEvents: snapshot.discardedEvents, controlUnavailable: Boolean(snapshot.controlUnavailable),
    notificationUnavailable: Boolean(snapshot.notificationUnavailable), cleanupUnavailable: Boolean(snapshot.cleanupUnavailable),
    latestUpdatedAt: Math.max(0, ...snapshot.missions.map(mission => mission.updatedAt)) }, `${label}: aggregate`)
  assert.deepEqual(read.cleanups, snapshot.cleanups, `${label}: cleanups`)
  const groups = new Map<string, MissionEvent[]>()
  for (const event of events) groups.set(event.missionID, [...groups.get(event.missionID) ?? [], event])
  const allCleanups = orderMissionCleanups([...groups.values()].flatMap(group => projectMissionCleanups(group)), Infinity)
  assert.deepEqual(read.allCleanups, allCleanups, `${label}: whole cleanup history`)
  if (allCleanups.filter(item => item.pending === 0).length > 20) coverage.settledBeyondHistory++

  // Open: unsettled work by its own map or pending cleanup, plus damage local to a range.
  const work = new Set([...snapshot.missions.filter(mapWork).map(mission => mission.id),
    ...(snapshot.cleanups ?? []).filter(cleanup => cleanup.pending > 0).map(cleanup => cleanup.missionID)])
  for (const id of work) assert.ok(read.open.includes(id), `${label}: ${id} open`)
  // Live maps in snapshot order (ties included), then the rest in binary key order.
  const rank = (id: string) => order.includes(id) ? order.indexOf(id) : Infinity
  assert.deepEqual(read.open, [...read.open].sort((left, right) => rank(left) - rank(right) || (`${left}/` < `${right}/` ? -1 : 1)), `${label}: open order`)
  if (!damaged) {
    const exact = new Set([...work, ...snapshot.missions.filter(mission => missionWorkRemains({ ...snapshot, missions: [mission], cleanups: [] })).map(mission => mission.id)])
    assert.deepEqual(new Set(read.open), exact, `${label}: open set`)
  } else {
    for (const id of read.open.filter(id => !work.has(id))) {
      const view = await f.journal.missionView(id)
      assert.ok(view.discardedEvents || view.controlUnavailable || view.notificationUnavailable || view.cleanupUnavailable
        || view.mission?.controlUnavailable || view.mission?.notificationUnavailable, `${label}: ${id} open only by its own damage`)
    }
  }
  assert.equal(read.open.length > 0 || damaged, missionWorkRemains(snapshot), `${label}: work remains`)
  if (read.open.length) coverage.open++
  return snapshot
}

test("the activation index answers every cross-mission question like the full snapshot across random histories", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const f = fixture(seed), deletions: MissionDeleteInput[] = []
    let snapshot = await assertIndexed(f, `seed ${seed} empty`, true)
    for (let n = 0; n < 70; n++) {
      const unconfirmed = f.unconfirmed()
      // Refusals, interrupted purges and failed or unconfirmed writes are part of the history.
      await step(f, n, snapshot, deletions, seed % 3 === 0, coverage, true).catch(() => { coverage.failed++ })
      coverage.unconfirmed += f.unconfirmed() - unconfirmed
      // Bytes no journal wrote are first seen by the next activation.
      const tampered = f.takeTampered()
      if (tampered) { f.activate(); coverage.activations++ }
      const writes = missionJournalWrites(f.journal.projectToken)
      if (!tampered && f.random() < 0.05) {
        // Another incarnation in this process writes through its own journal.
        await f.control(new MissionJournalIndex()).create({ requestID: `foreign-${seed}-${n}`, objective: "Foreign", template: "custom" })
          .catch(() => undefined)
        if (missionJournalWrites(f.journal.projectToken) !== writes) coverage.foreign++
      }
      snapshot = await assertIndexed(f, `seed ${seed} step ${n}`, tampered || missionJournalWrites(f.journal.projectToken) !== writes)
    }
  }
  for (const name of RANDOM_COVERAGE) assert.ok(coverage[name] > 0, `histories exercised ${name}`)
})

test("deterministic cross-mission edges: shared sessions, orphaned receipts, settled history beyond 20 and key-order ties", async () => {
  const f = fixture(3)
  // Built first, so every seeded write reaches it through the journal, not a rescan.
  await assertIndexed(f, "empty", true)
  const { first, second, shared, tied, updatedTie } = await seedCrossMission(f)
  const snapshot = await assertIndexed(f, "fixture", false)
  const read = await f.journal.readIndex(index => capture(index, [shared, "ses_msn_TieB"]))
  assert.deepEqual(read.refs.get(shared), [{ missionID: second.id, kinds: ["dispatching"] }, { missionID: first.id, kinds: ["dispatching"] }])
  assert.deepEqual(snapshot.missions.map(mission => mission.id), [...updatedTie, ...tied, second.id, first.id])
  assert.deepEqual([read.aggregate.controlUnavailable, read.aggregate.notificationUnavailable, read.aggregate.cleanupUnavailable], [true, true, true])
  assert.equal(read.cleanups.length, 21)
  assert.equal(read.allCleanups.length, 23)
  assert.ok(read.open.includes("msn_pending") && read.open.includes(first.id), "a pending cleanup and local damage keep work open")
  assert.ok(coverage.shared > 0 && coverage.settledBeyondHistory > 0)
})

test("a range whose deletion record could not be read is re-read until it can", async () => {
  const f = fixture(5)
  const { mission } = await f.control().create({ requestID: "gone", objective: "Gone", template: "custom" })
  await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision })
  await f.journal.purgeDeleted({ all: true })
  await f.journal.readIndex(() => undefined)
  // A late write to the purged mission: absorbed through its record.
  await f.journal.append({ version: 1, id: "evt_late", missionID: mission.id, projectID: "project-1", createdAt: 9_000, type: "task.dispatched", taskKey: "late" })
  f.failRecordReads(1)
  assert.equal(await f.journal.readIndex(index => index.aggregate().discardedEvents), 1,
    "an unreadable record keeps the late write as damage, as a snapshot would")
  assert.equal((await f.journal.snapshot()).discardedEvents, 0)
  assert.deepEqual(await f.journal.readIndex(index => [index.aggregate().discardedEvents, index.openIDs()]), [0, []], "the next read re-reads it")
  // During the build, which re-reads it once at once.
  f.activate()
  f.failRecordReads(2)
  assert.equal(await f.journal.readIndex(index => index.aggregate().discardedEvents), 1)
  assert.deepEqual(await f.journal.readIndex(index => [index.aggregate().discardedEvents, index.openIDs()]), [0, []])
})

test("writes by another incarnation or journal in this process rebuild the index; isolated and outside bytes are explicit", async () => {
  const f = fixture(7)
  const first = await f.control().create({ requestID: "first", objective: "First", template: "custom" })
  // Reads the index and reports whether it rescanned the project.
  const read = async () => {
    const scans = f.fullScans()
    const value = await f.journal.readIndex(index => ({ refs: index.refs(first.mission.coordinatorSessionId).map(ref => ref.missionID),
      latest: index.aggregate().latestUpdatedAt, open: index.openIDs() }))
    return { ...value, rebuilt: f.fullScans() > scans }
  }
  let leaked!: MissionIndexReader
  await f.journal.readIndex(index => { leaked = index })
  assert.throws(() => leaked.openIDs(), /read ended/, "a reader is valid only inside its callback")
  // Another activation's MissionControl (its own index) and an unindexed journal.
  const other = await f.control(new MissionJournalIndex()).create({ requestID: "other", objective: "Other", template: "custom" })
  assert.deepEqual(await read().then(value => [value.open.sort(), value.rebuilt]), [[first.mission.id, other.mission.id].sort(), true])
  await new MissionJournal(f.storage, f.project.id, f.project.canonical).append({ version: 1, id: "evt_unindexed", missionID: "msn_unindexed",
    projectID: "project-1", createdAt: 50_000, type: "mission.created", projectCanonical: "/repo", objective: "Unindexed", template: "custom",
    coordinator: { sessionID: first.mission.coordinatorSessionId, title: "Shared", location: { directory: "/repo" } } })
  assert.deepEqual(await read().then(value => [value.refs, value.rebuilt]), [["msn_unindexed", first.mission.id], true])
  // Interleaved foreign and own writes: the gap is seen even after an own write.
  await f.control(new MissionJournalIndex()).update({ missionID: other.mission.id, requestID: "foreign-update", expectedRevision: 1, objective: "Changed" })
  await f.control().update({ missionID: first.mission.id, requestID: "own-update", expectedRevision: 1, objective: "Mine" })
  assert.deepEqual(await read().then(value => [value.latest, value.rebuilt]), [(await f.journal.snapshot()).missions[0].updatedAt, true])
  // Own writes alone refresh their mission without a rescan.
  const own = await f.control().update({ missionID: first.mission.id, requestID: "own-again", expectedRevision: 2, objective: "Mine again" })
  assert.deepEqual(await read().then(value => [value.latest, value.rebuilt]), [own.mission.updatedAt, false])
  // Outside the boundary: bytes written without a journal (another process,
  // an earlier build, a crash) stay unseen until the next activation builds.
  f.tamper(`${f.prefix}/stray_outside`, { damaged: true })
  assert.equal(await f.journal.readIndex(index => index.aggregate().discardedEvents), 0)
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
  f.activate()
  assert.equal(await f.journal.readIndex(index => index.aggregate().discardedEvents), 1)
  // A disposed activation answers nothing.
  f.index.dispose()
  await assert.rejects(f.journal.readIndex(index => index.openIDs()), /index unavailable/)
  assert.throws(() => new MissionJournal(f.storage, "other-project", "/repo", undefined, f.index), /another project/)
})
