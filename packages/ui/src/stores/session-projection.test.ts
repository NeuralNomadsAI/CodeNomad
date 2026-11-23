import assert from "node:assert/strict"
import { test } from "node:test"
import type { Session } from "../types/session"
import { handleNativeSessionEvent } from "./session-events"
import { getListedSessionMap, getSessionCheckpoint, getSessionFamily, getSessionThreads, setSessionPage, setSessions } from "./session-state"
import { projectSessionFamilies, projectUnarchivedSessionThreads } from "./session-tree"

test("a session event among 6,000 rows only rebuilds the affected family", t => {
  const instanceId = "projection-test"
  const rows = new Map<string, Session>()
  const roots: string[] = []
  for (let i = 0; i < 6000; i++) {
    const id = `ses_${i}`
    const parentId = i % 2 ? `ses_${i - 1}` : null
    if (!parentId) roots.push(id)
    rows.set(id, { id, instanceId, parentId, title: id, status: "idle",
      location: { directory: "D:/fixture" }, time: { created: 1, updated: i } } as Session)
  }
  setSessions(new Map([[instanceId, rows]]))
  t.after(() => {
    setSessions(new Map())
    setSessionPage(instanceId, [], false, true)
  })
  setSessionPage(instanceId, roots, false, true)
  const favorites = new Set<string>()
  const project = () => projectSessionFamilies(projectUnarchivedSessionThreads(getSessionThreads(instanceId)), {
    sort: "activity", favoriteIds: favorites, getWorktreeLabel: directory => directory,
  })
  const initial = project()
  const family = getSessionFamily(instanceId, "ses_100")
  getListedSessionMap(instanceId)
  const captureBefore = getSessionCheckpoint(instanceId)
  const samples: number[] = []
  for (let i = 0; i < 31; i++) {
    const start = performance.now()
    handleNativeSessionEvent(instanceId, {
      id: `rename-${i}`, type: "session.renamed", created: i,
      durable: { aggregateID: "ses_1", seq: i, version: 1 },
      data: { sessionID: "ses_1", title: `New title ${i}` },
    } as Parameters<typeof handleNativeSessionEvent>[1])
    const projected = project()
    const updated = projected.at(-1)
    samples.push(performance.now() - start)
    assert.equal(updated?.children[0]?.session.title, `New title ${i}`)
    assert.ok(projected.slice(0, -1).every((thread, index) => thread === initial[index]))
    assert.equal(getSessionFamily(instanceId, "ses_100")[1], family[1])
  }
  assert.notEqual(getSessionCheckpoint(instanceId), captureBefore)
  samples.sort((a, b) => a - b)
  t.diagnostic(`6,000 rows, 31 events, p95 ${samples[29]!.toFixed(2)} ms`)
  assert.ok(samples[29]! < 16, `p95 event + projections: ${samples[29]!.toFixed(2)} ms`)
})
