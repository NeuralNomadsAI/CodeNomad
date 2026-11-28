import assert from "node:assert/strict"
import { test } from "node:test"
import type { Session } from "../types/session"
import { handleNativeSessionEvent } from "./session-events"
import { getListedSessionMap, getSessionCheckpoint, getSessionFamily, getSessionThreads, getSessionTopology, replaceSessionRow, setSessionPage, setSessions, withSession } from "./session-state"
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
  const elapsed: number[] = [], cpu: number[] = []
  let cpuStart = process.threadCpuUsage()
  for (let i = 0; i < 32; i++) {
    const start = performance.now()
    handleNativeSessionEvent(instanceId, {
      id: `rename-${i}`, type: "session.renamed", created: i,
      durable: { aggregateID: "ses_1", seq: i, version: 1 },
      data: { sessionID: "ses_1", title: `New title ${i}` },
    } as Parameters<typeof handleNativeSessionEvent>[1])
    const projected = project()
    const updated = projected.at(-1)
    elapsed.push(performance.now() - start)
    if ((i + 1) % 8 === 0) {
      // Amortize the Windows thread CPU clock's coarse accounting units.
      const usage = process.threadCpuUsage(cpuStart)
      cpu.push((usage.user + usage.system) / 8000)
      cpuStart = process.threadCpuUsage()
    }
    assert.equal(updated?.children[0]?.session.title, `New title ${i}`)
    assert.ok(projected.slice(0, -1).every((thread, index) => thread === initial[index]))
    assert.equal(getSessionFamily(instanceId, "ses_100")[1], family[1])
  }
  assert.notEqual(getSessionCheckpoint(instanceId), captureBefore)
  const elapsedP95 = elapsed.sort((a, b) => a - b)[30]!
  const maxMeanCpu = Math.max(...cpu)
  t.diagnostic(`6,000 rows, 32 events, p95 ${elapsedP95.toFixed(2)} ms elapsed, max batch mean ${maxMeanCpu.toFixed(2)} ms thread CPU/event`)
  setSessions(previous => replaceSessionRow(previous, instanceId, { ...rows.get("ses_1")!, id: "cold-child" }))
  const afterDiscovery = project()
  assert.ok(afterDiscovery.slice(0, -1).every((thread, index) => thread === initial[index]))
  assert.equal(afterDiscovery.at(-1)?.children.length, 2)
})

test("catalog checkpoints detect nested edits and only invalidate replaced workspace maps", t => {
  const instanceId = "projection-mutated-catalog"
  const row = { id: "root", instanceId, parentId: null, status: "working", time: { created: 1, updated: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as Session
  const rows = new Map([[row.id, row]])
  setSessions(new Map([[instanceId, rows], ["unaffected", new Map()]]))
  t.after(() => setSessions(new Map()))
  const initial = getSessionCheckpoint(instanceId)
  withSession(instanceId, "root", row => { row.tokens.cache.write++ })
  assert.equal(getSessionCheckpoint(instanceId), initial, "busy usage is deferred")
  withSession(instanceId, "root", row => { row.time.updated++ })
  assert.notEqual(getSessionCheckpoint(instanceId), initial)
  assert.equal(row.time.updated, 1, "retained snapshots keep their original values")
  const topology = getSessionTopology(instanceId)
  const unaffected = getSessionCheckpoint("unaffected")
  setSessions(previous => new Map(previous).set(instanceId,
    new Map(previous.get(instanceId)).set("child", { ...row, id: "child", parentId: "root" })))
  assert.notEqual(getSessionTopology(instanceId), topology)
  assert.equal(getSessionCheckpoint("unaffected"), unaffected)
})
