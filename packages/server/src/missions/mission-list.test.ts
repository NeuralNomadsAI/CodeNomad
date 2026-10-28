import assert from "node:assert/strict"
import test from "node:test"

import type { MissionDeleteInput } from "./control-types"
import { fixture, seedCrossMission, step, type HistoryFixture } from "./journal-history-fixture"
import { MISSION_LIST_MAX_INCLUDE, missionSummary } from "./mission-summary"
import type { MissionSnapshot } from "./model"

/** The panel's reads equal what the full snapshot shows: every row, the open and
 * included maps, the cleanup history and the project flags. */
async function assertListed(f: HistoryFixture, label: string, include: string[]) {
  const snapshot = await f.journal.snapshot()
  const open = new Set(await f.journal.readHints(hints => hints.openIDs()))
  const listed = await f.control().list({ include })
  assert.deepEqual(listed.summaries, snapshot.missions.map(missionSummary), `${label}: rows`)
  assert.deepEqual(listed.missions, snapshot.missions.filter(mission => open.has(mission.id) || include.includes(mission.id)), `${label}: full maps`)
  const flags = (value: Pick<MissionSnapshot, "controlUnavailable" | "notificationUnavailable" | "cleanupUnavailable" | "discardedEvents" | "cleanups">) =>
    [value.discardedEvents, value.controlUnavailable, value.notificationUnavailable, value.cleanupUnavailable, value.cleanups]
  assert.deepEqual(flags(listed), flags(snapshot), `${label}: history and flags`)
  for (const missionID of include) {
    const read = await f.control().mission(missionID)
    assert.deepEqual(read.mission, snapshot.missions.find(mission => mission.id === missionID), `${label}: read ${missionID}`)
    for (const cleanup of snapshot.cleanups ?? []) if (cleanup.missionID === missionID) assert.ok(read.cleanups.some(item => item.deletionID === cleanup.deletionID), `${label}: ${missionID} cleanup`)
    assert.deepEqual([read.controlUnavailable, read.notificationUnavailable], [snapshot.controlUnavailable, snapshot.notificationUnavailable], `${label}: read flags`)
    if (snapshot.cleanupUnavailable) assert.equal(read.cleanupUnavailable, true, `${label}: read cleanup flag`)
  }
  return snapshot
}

test("the panel list equals the snapshot's projection across random histories", async () => {
  const counters = { purged: 0, interrupted: 0 }
  let closedIncluded = 0
  for (let seed = 1; seed <= 10; seed++) {
    const f = fixture(seed), deletions: MissionDeleteInput[] = []
    let snapshot = await assertListed(f, `seed ${seed} empty`, [])
    for (let n = 0; n < 40; n++) {
      await step(f, n, snapshot, deletions, seed % 3 === 0, counters, true).catch(() => undefined)
      // Bytes no journal wrote reach the hints with the next activation.
      if (f.takeTampered()) f.activate()
      const include = [f.pick(snapshot.missions)?.id, "msn_unknown"].filter((id): id is string => Boolean(id))
      const open = new Set(await f.journal.readHints(hints => hints.openIDs()))
      if (include.some(id => !open.has(id) && snapshot.missions.some(mission => mission.id === id))) closedIncluded++
      snapshot = await assertListed(f, `seed ${seed} step ${n}`, include)
    }
  }
  assert.ok(closedIncluded > 0 && counters.purged > 0, "histories included closed maps and purges")
})

test("cross-mission edges list like the snapshot: ties, settled history beyond 20, local damage", async () => {
  const f = fixture(3)
  const { first, tied } = await seedCrossMission(f)
  const snapshot = await assertListed(f, "fixture", [first.id, ...tied].slice(0, MISSION_LIST_MAX_INCLUDE))
  assert.equal(snapshot.cleanups?.length, 21)
})

test("an unchanged row list is skipped by version, and comes back after a write", async () => {
  const f = fixture(5)
  const { mission } = await f.control().create({ requestID: "one", objective: "One", template: "custom" })
  const first = await f.control().list()
  assert.equal(first.summaries?.length, 1)
  const repeated = await f.control().list({ summariesVersion: first.summariesVersion })
  assert.deepEqual([repeated.summaries, repeated.summariesVersion, repeated.missions], [undefined, first.summariesVersion, first.missions])
  await f.control().update({ missionID: mission.id, requestID: "edit", objective: "One, edited", expectedRevision: mission.revision })
  const changed = await f.control().list({ summariesVersion: first.summariesVersion })
  assert.notEqual(changed.summariesVersion, first.summariesVersion)
  assert.equal(changed.summaries?.[0]?.objective, "One, edited")
  // Includes are deduplicated and bounded like the RPC schema.
  const many = await f.control().list({ include: Array.from({ length: 8 }, (_, index) => `msn_${index % 6}`) })
  assert.deepEqual(many.missions.map(value => value.id), [mission.id])
})

test("rows miss a foreign write until the rebuild, while an included mission's range is read at once", async () => {
  const f = fixture(6)
  await f.control().create({ requestID: "own", objective: "Own", template: "custom" })
  await f.control().list()
  const location = { directory: "/repo" }
  f.tamper(`${f.prefix}/msn_elsewhere/evt_created`, { version: 1, id: "evt_created", missionID: "msn_elsewhere", projectID: "project-1",
    createdAt: 90_000, type: "mission.created", projectCanonical: "/repo", objective: "Elsewhere", template: "custom",
    coordinator: { sessionID: "ses_elsewhere", title: "Coordinator", location } })
  assert.equal((await f.control().list()).summaries?.some(row => row.id === "msn_elsewhere"), false, "a hint, never proof")
  const selected = await f.control().list({ include: ["msn_elsewhere"] })
  assert.deepEqual([selected.missions.some(value => value.id === "msn_elsewhere"), selected.summaries?.[0]?.id], [true, "msn_elsewhere"])
  assert.equal((await f.control().mission("msn_elsewhere")).mission?.objective, "Elsewhere")
  f.advanceIndexClock(60_000)
  assert.equal((await f.control().list()).summaries?.[0]?.id, "msn_elsewhere")
})

test("a row's objective label keeps what its title reads and nothing beyond", () => {
  const base = (objective: string) => missionSummary({ version: 1, id: "msn_a", projectID: "p", projectCanonical: "/repo", objective, template: "custom",
    status: "completed", coordinatorSessionId: "ses_c", actors: [{ sessionId: "ses_c", kind: "coordinator", managed: false, title: "C", roles: [],
      location: { directory: "/repo" }, joinedAt: 1 }], tasks: [], reports: [], frontier: [], claims: [], createdAt: 1, updatedAt: 2, revision: 3,
    history: [], historyTruncated: false })
  assert.deepEqual(base("  Fix   the\tbuild.\n\n  Then   ship  "), { id: "msn_a", objective: "Fix the build.\nThen ship", status: "completed",
    coordinatorSessionId: "ses_c", actorSessionIds: ["ses_c"], updatedAt: 2, revision: 3 })
  assert.equal(Array.from(base("é".repeat(20_000)).objective).length, 502)
})
