import assert from "node:assert/strict"
import test from "node:test"
import { fixture } from "../../../server/src/missions/journal-history-fixture"
import { readMissionPanelWindow, readMissionTaskPage } from "../../src/lib/mission-task-page-read"
import { createMissionPanelInventory } from "../../src/stores/mission-panel-inventory"
import type { MissionPanelPageRequest } from "../../../server/src/missions/mission-panel-wire"

function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

for (const phase of ["first", "retry"] as const) for (const part of ["receipts", "pending"] as const) for (const text of [false, true])
  test(`late ${phase} ${part} ${text ? "raw" : "structured"} response retains a newer owning-source invalidation`, async () => {
    const f = fixture(126420), control = f.control(), held = gate(), entered = gate(), requests: MissionPanelPageRequest[] = []
    let holding = false
    const exchange = async (body: string) => {
      const request = JSON.parse(body); requests.push(request)
      const answer = await control.panelPage(request)
      if (holding && request.source === "mission" && request.part === part && !!request.text === text) {
        holding = false; entered.release(); await held.promise
      }
      return new Response(JSON.stringify(answer))
    }
    const store = createMissionPanelInventory({ scope: () => `late-${phase}-${part}-${text}`,
      tasks: (_i, id, task, scope) => readMissionTaskPage(id, task, { ...scope, exchange }),
      read: (_i, selector, scope) => selector.source === "marks" || selector.source === "activity" ? Promise.reject(Error("Unknown native state"))
        : readMissionPanelWindow(selector, { ...scope, exchange, runTransfer: read => read() }) })
    let map = (await control.create({ requestID: "create", objective: "Field provenance", template: "custom", prepared: true })).mission
    map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "start", action: "start" })).mission
    const key = `${text ? "text" : "field"}:${map.id}:control:${part}`
    const shown = () => text ? store.fieldText("fixture", map.id, `control:${part}`, 0) : store.fieldValues("fixture", map.id, `control:${part}`)
    try {
      store.setDemand("fixture", true); store.want("fixture", "selection", map.id); await store.ensure("fixture")
      if (phase === "retry") {
        await store.more("fixture", key)
        map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "graceful-pause", action: "pause", graceful: true })).mission
        await store.refresh("fixture", false)
        assert.equal(store.progress("fixture", key).failure, "changed", "the real visible Retry is available")
      }
      const retained = structuredClone(shown())
      holding = true; const oldRead = store.more("fixture", key, phase === "retry")
      await entered.promise
      if (part === "pending") f.failing.add(map.coordinatorSessionId)
      try {
        map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "new-control", action: phase === "retry" ? "start" : "pause" })).mission
      } catch (error) {
        assert.equal((error as { code: string }).code, "control-pending")
        map = (await control.snapshot()).missions.find(value => value.id === map.id)!
      }
      if (part === "pending") assert.equal(map.control!.pending.length, 1, "the newer control genuinely has an outstanding target")
      await store.refresh("fixture", false)
      assert.equal(store.state("fixture").missions[0].revision, map.revision)
      if (phase === "retry") assert.equal(store.progress("fixture", key).failure, "changed")
      const reads = requests.filter(request => request.source === "mission" && request.part === part).length
      held.release(); await oldRead
      assert.equal(store.progress("fixture", key).failure, "changed", "late first reads and Retries cannot retire later invalidations")
      assert.deepEqual(shown(), retained, "keep last-good values without adopting the stale response")
      assert.equal(requests.filter(request => request.source === "mission" && request.part === part).length, reads, "no automatic field reread")
      await store.more("fixture", key, true)
      assert.equal(store.progress("fixture", key).failure, undefined)
      assert.deepEqual(text ? JSON.parse(shown() as string) : shown(), JSON.parse(JSON.stringify(map.control![part])))
    } finally { held.release(); store.clear("fixture") }
  })

for (const part of ["receipts", "pending"] as const) for (const text of [false, true])
  test(`an unrelated header revision preserves a pending ${part} ${text ? "raw" : "structured"} read with the same owning descriptor`, async () => {
    const f = fixture(126421), control = f.control(), held = gate(), entered = gate()
    let holding = false
    const exchange = async (body: string) => {
      const request = JSON.parse(body), answer = await control.panelPage(request)
      if (holding && request.part === part) { holding = false; entered.release(); await held.promise }
      return new Response(JSON.stringify(answer))
    }
    const store = createMissionPanelInventory({ scope: () => `same-source-${part}-${text}`,
      tasks: (_i, id, task, scope) => readMissionTaskPage(id, task, { ...scope, exchange }),
      read: (_i, selector, scope) => selector.source === "marks" || selector.source === "activity" ? Promise.reject(Error("Unknown native state"))
        : readMissionPanelWindow(selector, { ...scope, exchange, runTransfer: read => read() }) })
    let map = (await control.create({ requestID: "create", objective: "Same source", template: "custom", prepared: true })).mission
    map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "start", action: "start" })).mission
    try {
      store.setDemand("fixture", true); store.want("fixture", "selection", map.id); await store.ensure("fixture")
      const descriptor = store.state("fixture").missions[0].panelCollections!.control
      const revision = map.revision, key = `${text ? "text" : "field"}:${map.id}:control:${part}`
      holding = true; const read = store.more("fixture", key)
      await entered.promise
      map = (await control.update({ missionID: map.id, requestID: "notes", expectedRevision: map.revision, objective: map.objective, notes: "Unrelated notes" })).mission
      await store.refresh("fixture", false)
      assert.ok(map.revision > revision)
      assert.deepEqual(store.state("fixture").missions[0].panelCollections!.control, descriptor)
      held.release(); await read
      assert.equal(store.progress("fixture", key).failure, undefined)
      const values = text ? JSON.parse(store.fieldText("fixture", map.id, `control:${part}`, 0)!) : store.fieldValues("fixture", map.id, `control:${part}`)
      assert.deepEqual(values, JSON.parse(JSON.stringify(map.control![part])))
    } finally { held.release(); store.clear("fixture") }
  })
