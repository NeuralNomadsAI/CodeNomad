import assert from "node:assert/strict"
import test from "node:test"
import type { MissionDeleteInput } from "./control-types"
import type { MissionView } from "./journal"
import { compareEvents, MISSION_MAX_EVENTS, type MissionCleanup, type MissionMap } from "./model"
import { SETTLED_CLEANUP_HISTORY } from "./cleanup-projection"
import { fixture, seedCrossMission, step, type HistoryFixture } from "./journal-history-fixture"

const coverage = { types: new Set<string>(), damagedViews: 0, remnants: 0, purged: 0, interrupted: 0, ties: 0 }

/** Every mission range's view, recomposed, is exactly today's project snapshot. */
async function assertEquivalent(f: HistoryFixture, label: string) {
  const snapshot = await f.journal.snapshot(), observed = await f.journal.events()
  const ranges = new Map<string, number>()
  let stray = 0
  for (const key of f.values.keys()) {
    if (!key.startsWith(f.prefix)) continue
    const missionID = /^\/([A-Za-z0-9_-]{3,100})\//.exec(key.slice(f.prefix.length))?.[1]
    if (missionID) ranges.set(missionID, (ranges.get(missionID) ?? 0) + 1)
    else stray++
  }
  // Every range, every listed mission, plus an unknown and an unsafe ID that own nothing.
  const ids = [...new Set([...ranges.keys(), ...snapshot.missions.map(mission => mission.id), "msn_unknown", "../escape"])]
    .sort((left, right) => `${left}/` < `${right}/` ? -1 : 1)
  const views: MissionView[] = []
  let rawDiscarded = 0
  for (const id of ids) {
    const view = await f.journal.missionView(id), events = await f.journal.missionEvents(id)
    assert.equal(view.missionID, id)
    assert.equal(view.projectID, snapshot.projectID, label)
    assert.deepEqual(events.events, view.events, `${label}: ${id} events`)
    if (!ranges.has(id)) assert.deepEqual([view.events, view.discardedEvents, view.mission], [[], 0, undefined], `${label}: ${id} owns no range`)
    if (ranges.get(id) && !view.events.length && !events.discardedEvents) coverage.remnants++
    if (view.controlUnavailable || view.notificationUnavailable || view.cleanupUnavailable || view.discardedEvents) coverage.damagedViews++
    rawDiscarded += events.discardedEvents
    views.push(view)
  }
  // Maps: identical once the project-wide damage is stamped on them.
  const stamp = (mission: MissionMap) => ({ ...mission, ...(snapshot.controlUnavailable ? { controlUnavailable: true } : {}),
    ...(snapshot.notificationUnavailable ? { notificationUnavailable: true } : {}) })
  const live = views.filter(view => view.mission)
  assert.deepEqual(snapshot.missions.map(mission => mission.id).sort(), live.map(view => view.missionID).sort(), `${label}: listed missions`)
  for (const view of live) assert.deepEqual(stamp(view.mission!), snapshot.missions.find(mission => mission.id === view.missionID), `${label}: ${view.missionID}`)
  // Order: newest update first, ties in the order of each group's first event.
  const first = (view: MissionView) => [...view.events].sort(compareEvents)[0]
  const ordered = [...live].sort((left, right) => right.mission!.updatedAt - left.mission!.updatedAt || compareEvents(first(left), first(right)))
  assert.deepEqual(ordered.map(view => view.missionID), snapshot.missions.map(mission => mission.id), `${label}: order`)
  for (let index = 1; index < live.length; index++) if (ordered[index].mission!.updatedAt === ordered[index - 1].mission!.updatedAt) coverage.ties++
  // Project aggregates: per-range values plus damage outside every range.
  assert.deepEqual(views.flatMap(view => view.events), observed.events, `${label}: events in key order`)
  assert.equal(rawDiscarded + stray, observed.discardedEvents, `${label}: raw discarded`)
  assert.equal(views.reduce((sum, view) => sum + view.discardedEvents, 0) + stray, snapshot.discardedEvents, `${label}: discarded`)
  for (const flag of ["controlUnavailable", "notificationUnavailable", "cleanupUnavailable"] as const) {
    assert.equal(Boolean(snapshot[flag]), stray > 0 || views.some(view => view[flag]), `${label}: ${flag}`)
  }
  assert.deepEqual(mergeCleanups(views.flatMap(view => view.cleanups ?? [])), snapshot.cleanups, `${label}: cleanups`)
  for (const event of observed.events) coverage.types.add(event.type)
  return snapshot
}

function mergeCleanups(items: MissionCleanup[]) {
  const ordered = items.sort((a, b) => b.createdAt - a.createdAt || a.deletionID.localeCompare(b.deletionID))
  return [...ordered.filter(item => item.pending > 0), ...ordered.filter(item => item.pending === 0).slice(0, SETTLED_CLEANUP_HISTORY)]
}


test("a mission's range view equals that mission in the project snapshot across random MissionControl histories", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const f = fixture(seed), deletions: MissionDeleteInput[] = []
    let snapshot = await assertEquivalent(f, `seed ${seed} empty`)
    for (let n = 0; n < 70; n++) {
      // Refusals and injected failures are part of the history: the journal is what is compared.
      await step(f, n, snapshot, deletions, seed % 3 === 0, coverage).catch(() => undefined)
      snapshot = await assertEquivalent(f, `seed ${seed} step ${n}`)
    }
  }
  for (const type of ["mission.created", "mission.updated", "mission.reopened", "mission.revised", "mission.briefed", "mission.finished", "mission.deleted",
    "mission.session-cleaned", "mission.control-requested", "mission.control-applied", "task.created", "task.dispatching", "task.dispatched",
    "task.reported", "report.notified"]) assert.ok(coverage.types.has(type), `histories exercised ${type}`)
  for (const [name, count] of Object.entries(coverage)) if (typeof count === "number") assert.ok(count > 0, `histories exercised ${name}`)
})

test("cross-mission edges compose: shared sessions, one range's orphaned receipts, cleanup history and key-order ties", async () => {
  const f = fixture(3)
  const { first, second, shared, tied, updatedTie } = await seedCrossMission(f)

  const snapshot = await assertEquivalent(f, "fixture")
  const [firstView, secondView] = [await f.journal.missionView(first.id), await f.journal.missionView(second.id)]
  const listed = (id: string) => snapshot.missions.find(mission => mission.id === id)!
  // Local damage stays in its range; the project flags stamp every listed map.
  assert.deepEqual([firstView.controlUnavailable, firstView.notificationUnavailable, firstView.cleanupUnavailable, firstView.discardedEvents], [true, true, true, 0])
  assert.deepEqual([secondView.controlUnavailable, secondView.notificationUnavailable, secondView.cleanupUnavailable, secondView.discardedEvents], [undefined, undefined, undefined, 0])
  assert.deepEqual([secondView.mission!.controlUnavailable, secondView.mission!.notificationUnavailable], [undefined, undefined])
  assert.deepEqual([snapshot.controlUnavailable, snapshot.notificationUnavailable, snapshot.cleanupUnavailable, snapshot.discardedEvents], [true, true, true, 0])
  for (const mission of snapshot.missions) assert.deepEqual([mission.controlUnavailable, mission.notificationUnavailable], [true, true], mission.id)
  assert.deepEqual(listed(second.id), { ...secondView.mission!, controlUnavailable: true, notificationUnavailable: true })
  assert.deepEqual(listed(first.id), firstView.mission)
  // The shared session is an exact actor of both maps.
  for (const view of [firstView, secondView]) {
    const actor = view.mission!.actors.find(item => item.sessionId === shared)
    assert.equal(actor?.kind, "specialist", view.missionID)
    assert.deepEqual(actor, listed(view.missionID).actors.find(item => item.sessionId === shared))
  }
  assert.equal(firstView.mission!.tasks[0].actorSessionId, shared)
  assert.equal(secondView.mission!.tasks.find(task => task.key === "reuse")?.actorSessionId, shared)
  // Every deleted range contributes its own cleanup; only the project truncates.
  const gone = await Promise.all(Array.from({ length: 22 }, (_, index) => f.journal.missionView(`msn_gone_${String(index).padStart(2, "0")}`)))
  assert.ok(gone.every(view => view.cleanups?.length === 1 && !view.mission))
  assert.deepEqual(snapshot.cleanups?.map(item => item.missionID), ["msn_pending",
    ...Array.from({ length: 20 }, (_, index) => `msn_gone_${String(21 - index).padStart(2, "0")}`)])
  assert.deepEqual(mergeCleanups([...gone, await f.journal.missionView("msn_pending")].flatMap(view => view.cleanups ?? [])), snapshot.cleanups)
  // Ties: equally updated maps by first event, then three full ties in key order, ahead of the older ones.
  assert.deepEqual(snapshot.missions.map(mission => mission.id), [...updatedTie, ...tied, second.id, first.id])
})

test("a mission range keeps its read bound in range and project reads", async () => {
  const f = fixture(1)
  const { mission } = await f.control().create({ requestID: "large", objective: "Large", template: "custom" })
  for (let index = 0; index <= MISSION_MAX_EVENTS; index++) f.values.set(`${f.prefix}/${mission.id}/evt_filler_${index}`, { damaged: true })
  await assert.rejects(f.journal.missionView(mission.id), new RegExp(`${MISSION_MAX_EVENTS}-event safety limit`))
  await assert.rejects(f.journal.snapshot(), new RegExp(`${MISSION_MAX_EVENTS}-event safety limit`))
  await assert.rejects(f.journal.readHints(hints => hints.openIDs()), new RegExp(`${MISSION_MAX_EVENTS}-event safety limit`))
})

test("a mission range read never straddles a purge", async () => {
  const f = fixture(2)
  let mission = (await f.control().create({ requestID: "deleted", objective: "Deleted", template: "custom" })).mission
  for (let index = 0; index < 120; index++) mission = (await f.control().update({ missionID: mission.id, requestID: `update-${index}`,
    expectedRevision: mission.revision, objective: `Deleted ${index}` })).mission
  await f.control().delete({ missionID: mission.id, requestID: "delete", expectedRevision: mission.revision })
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve }), resume = new Promise<void>(resolve => { release = resolve })
  f.pauseFirstPage(async () => { entered(); await resume })
  const reading = f.journal.missionView(mission.id)
  await paused
  const purge = f.journal.purgeDeleted({ all: true })
  assert.equal(await Promise.race([purge.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 50, false))]), false,
    "the purge waits for the range read already in progress")
  release()
  const view = await reading
  assert.equal(view.discardedEvents, 0)
  assert.equal(view.cleanups?.[0]?.missionID, mission.id, "the read saw the whole tombstoned range")
  assert.equal(await purge, 122)
  assert.deepEqual([(await f.journal.missionView(mission.id)).events, (await f.journal.missionView(mission.id)).cleanups], [[], []])
})
