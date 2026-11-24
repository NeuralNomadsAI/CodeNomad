import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, missionFinishCounterKey, type MissionStorage } from "./journal"
import type { MissionEvent, MissionJsonValue } from "./model"
import { isolatedMissionPassageJournal } from "./mission-document-passage-storage"

function fixture(isolated = false) {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    remove: async key => { values.delete(key) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)!) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
    ...(isolated ? { isolated: true as const } : {}),
  }
  const created = (missionID: string): MissionEvent => ({ version: 1, id: "evt_created", type: "mission.created", missionID, projectID: "project",
    projectCanonical: "/repo", objective: "Objective", template: "custom", coordinator: { sessionID: `ses_${missionID}`, title: "Coordinator",
      location: { directory: "/repo" } }, createdAt: 10 })
  const finished = (missionID: string, createdAt = 20) => ({ version: 1 as const, id: "evt_finished", type: "mission.finished" as const, missionID,
    projectID: "project", outcome: "completed" as const, summary: "Done", createdAt })
  return { values, storage, journal: new MissionJournal(storage, "project", "/repo"), created, finished }
}

test("finishes are numbered in commit order outside every mission range, whatever their clocks", async () => {
  const f = fixture()
  for (const [index, missionID] of ["msn_aaa", "msn_bbb", "msn_ccc"].entries()) {
    await f.journal.append(f.created(missionID))
    // Each finish runs on an earlier clock than the last.
    assert.equal((await f.journal.appendFinish(f.finished(missionID, 1_000 - index))).type === "mission.finished"
      && (await f.journal.missionView(missionID)).mission?.finishSequence, index + 1)
  }
  const snapshot = await f.journal.snapshot()
  assert.deepEqual([snapshot.discardedEvents, snapshot.missions.map(mission => mission.finishSequence).sort()], [0, [1, 2, 3]])
  assert.deepEqual(f.values.get(missionFinishCounterKey(f.journal.projectToken)), { version: 1, projectID: "project", finishes: 3 })
  // An exact replay returns the stored finish and draws no number; another body collides.
  assert.equal((await f.journal.appendFinish(f.finished("msn_ccc", 998)) as { sequence?: number }).sequence, 3)
  await assert.rejects(f.journal.appendFinish({ ...f.finished("msn_ccc", 998), summary: "Other" }), /identity collision/)
  // Another journal over the same storage, as after a plugin reload, continues the count.
  const reloaded = new MissionJournal(f.storage, "project", "/repo")
  await reloaded.append(f.created("msn_ddd"))
  assert.equal((await reloaded.appendFinish(f.finished("msn_ddd", 1)) as { sequence?: number }).sequence, 4)
})

test("a damaged finish counter refuses the finish; isolated passages draw no number", async () => {
  const f = fixture()
  await f.journal.append(f.created("msn_aaa"))
  f.values.set(missionFinishCounterKey(f.journal.projectToken), { version: 1, projectID: "project", finishes: "three" })
  await assert.rejects(f.journal.appendFinish(f.finished("msn_aaa")), /counter is damaged/)
  assert.equal((await f.journal.snapshot()).missions[0].status, "active")
  const isolated = fixture(true)
  await isolated.journal.append(isolated.created("msn_aaa"))
  assert.equal((await isolated.journal.appendFinish(isolated.finished("msn_aaa")) as { sequence?: number }).sequence, undefined)
  assert.equal(isolated.values.has(missionFinishCounterKey(isolated.journal.projectToken)), false)
  assert.equal((await isolated.journal.snapshot()).missions[0].finishSequence, undefined)
})

test("a unified scheduled passage finishes in its isolated journal without accessing the ordinary project's finish counter", async () => {
  const f = fixture()
  const passage = isolatedMissionPassageJournal(f.storage, { projectID: "project", projectCanonical: "/repo", ownerID: "schedule",
    passageID: "passage", storagePrefix: "codenomad-missions/documents-v1" }, () => true)
  await passage.journal.append(f.created(passage.missionID))
  await passage.journal.appendFinish(f.finished(passage.missionID))
  assert.equal((await passage.journal.missionView(passage.missionID)).mission?.finishSequence, undefined)
  const counter = missionFinishCounterKey(passage.journal.projectToken)
  assert.equal(f.values.has(counter), false)
  await assert.rejects(passage.storage.get(counter), /Passage journal scope conflict/)
  await assert.rejects(passage.storage.set(counter, { version: 1, projectID: "project", finishes: 1 }), /Passage journal scope conflict/)
})
