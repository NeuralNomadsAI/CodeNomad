import assert from "node:assert/strict"
import test from "node:test"
import { fixture } from "../../../server/src/missions/journal-history-fixture"
import { parseMissionEvent, missionFinishCounterKey } from "../../../server/src/missions/journal"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { cleanupReceiptID } from "../../../server/src/missions/cleanup-projection"
import { readMissionPanelWindow, readMissionTaskPage } from "../../src/lib/mission-task-page-read"
import { createMissionPanelInventory } from "../../src/stores/mission-panel-inventory"
import type { MissionPanelPageRequest } from "../../../server/src/missions/mission-panel-wire"
import { missionPanelHeader } from "../../../server/src/missions/mission-panel-header"
import { missionPanelWindow, missionPanelPage, missionPanelTextWindow } from "../../../server/src/missions/mission-panel-page"
import { missionLifecycleSource } from "../../src/stores/mission-lifecycle-intents"
import { missionFinishedSeen, markMissionsFinishedSeen } from "../../src/stores/mission-view-state"
import { panelCleanupSchema, panelHistorySchema } from "../../src/lib/mission-panel-schema"
import { preparationFixture, scheduledPreparation } from "../../../server/src/missions/mission-preparation-test-fixture"
import { missionActivityContext } from "../../../server/src/missions/mission-activity-context"

function seeded(count = 120, actors = 0) {
  const f = fixture(4264)
  const seed = (input: Record<string, unknown>) => {
    const event = parseMissionEvent({ version: 1, projectID: f.project.id, ...input })
    assert.ok(event, String(input.id)); f.tamper(`${f.prefix}/${event.missionID}/${event.id}`, event as never)
  }
  for (let index = 0; index < count; index++) seed({ id: "evt_created", missionID: `msn_${index}`, type: "mission.created", projectCanonical: "/repo", objective: `Mission ${index}`, template: "custom",
    coordinator: { sessionID: `ses_${index}`, title: "Coordinator", location: f.project.location }, createdAt: count - index })
  for (let index = 0; index < actors; index++) {
    seed({ id: `evt_task_${index}`, missionID: "msn_119", type: "task.created", task: { id: `tsk_${index}`, key: `task-${index}`, title: "Actor", brief: "Brief", role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: count + index * 2 + 1 })
    seed({ id: `evt_bound_${index}`, missionID: "msn_119", type: "task.native-bound", taskKey: `task-${index}`, binding: { generation: 1, parentSessionID: "ses_119", parentMessageID: `msg_${index}`, toolCallID: `call_${index}` },
      actor: { sessionID: `ses_far_${index}`, title: "Actor", managed: true, location: { directory: "/" + "d".repeat(19_999) } }, createdAt: count + index * 2 + 2 })
  }
  const control = f.control(), selectors: MissionPanelPageRequest[] = [], bodies: number[] = []
  const exchange = async (body: string) => {
    const selector = JSON.parse(body); selectors.push(selector)
    const value = await control.panelPage(selector), text = JSON.stringify(value); bodies.push(Buffer.byteLength(text))
    return new Response(text)
  }
  const read = (selector: Exclude<MissionPanelPageRequest, { source: "tasks" }>) => readMissionPanelWindow(selector, { current: () => true, exchange, runTransfer: read => read() })
  return { ...f, control, read, exchange, bodies, selectors }
}

test("the actual 120-mission first window verifies alone, with zero warm ranges and no map fan-out", async t => {
  const f = seeded(), answer = await f.read({ source: "summaries", initial: true, window: { offset: 0 } })
  assert.equal(answer.values.length, 50); assert.equal(answer.envelope.window?.total, 120)
  assert.equal(contentDigest(JSON.stringify(answer.values)), answer.envelope.page.digest)
  assert.ok(answer.values.every(row => !Object.hasOwn(row as object, "actorSessionIds") && !Object.hasOwn(row as object, "tasks")))
  assert.equal(f.selectors.length, 1); assert.equal(answer.envelope.finishHighWater, 0)
  const before = f.scannedEntries(); await f.read({ source: "summaries", window: { offset: 50, order: answer.envelope.window!.order } })
  assert.equal(f.scannedEntries(), before)
  await f.journal.append({ version: 1, projectID: f.project.id, missionID: "msn_119", id: "evt_updated", type: "mission.updated", requestID: "tail", expectedRevision: 1,
    objective: "Unseen changed", notesSpecified: false, createdAt: 1 })
  const next = await f.read({ source: "summaries", window: { offset: 0 } })
  assert.deepEqual(next.values, answer.values); assert.equal(next.envelope.page.digest, answer.envelope.page.digest)
  assert.notEqual(next.envelope.window!.order, answer.envelope.window!.order)
  await assert.rejects(f.read({ source: "summaries", window: { offset: 50, order: answer.envelope.window!.order } }), { reason: "changed" })
  t.diagnostic(`first window ${f.bodies[0]} bytes; 1 transfer; 50/120 summaries; 0 warm source entries; 0 maps`)
})

for (const source of ["summaries", "cleanups"] as const) test(`passive ${source} first-window validation retains a failed middle across an unseen-tail order change`, async () => {
  const f = seeded()
  if (source === "cleanups") for (let index = 0; index < 120; index++) {
    await f.journal.append({ version: 1, projectID: f.project.id, missionID: `msn_${index}`, id: "evt_deleted", type: "mission.deleted",
      requestID: `delete-${index}`, expectedRevision: 1, deleteManagedSessions: true,
      cleanupTargets: [{ sessionID: `ses_pending_${index}`, location: f.project.location }], createdAt: 1000 - index })
  }
  let fail = true
  const requests: MissionPanelPageRequest[] = []
  const store = createMissionPanelInventory({ scope: () => `tail-${source}`, tasks: async () => { throw Error("No task fallback") },
    read: (_instance, selector, scope) => readMissionPanelWindow(selector, { ...scope, runTransfer: read => read(), exchange: async body => {
      const request = JSON.parse(body); requests.push(request)
      if (request.source === source && request.window?.offset === 50 && fail) throw Error("Middle transport failure")
      return f.exchange(body)
    } }) })
  try {
    store.setDemand("fixture", true); await store.ensure("fixture"); await store.more("fixture", source)
    assert.equal(store.progress("fixture", source).failure, "failed")
    if (source === "summaries") await f.control.update({ missionID: "msn_119", requestID: "tail-edit", expectedRevision: 1, objective: "Moved unseen tail" })
    else await f.journal.append({ version: 1, projectID: f.project.id, missionID: "msn_119", id: cleanupReceiptID("evt_deleted", "ses_pending_119"), type: "mission.session-cleaned",
      deletionID: "evt_deleted", sessionID: "ses_pending_119", outcome: "removed", createdAt: 2000 })
    const before = requests.length
    await store.refresh("fixture", false)
    assert.equal(store.progress("fixture", source).failure, "changed")
    assert.equal(store.progress("fixture", source).loaded, 50)
    if (source === "summaries") assert.equal(store.state("fixture").summaries.length, 51, "retained display includes the moved tail, separate from the current prefix")
    assert.ok(requests.slice(before).every(request => request.source !== source || request.window?.offset === 0))
    fail = false; await store.more("fixture", source, true)
    assert.equal(store.progress("fixture", source).failure, undefined)
    assert.deepEqual(requests.filter(request => request.source === source).at(-1)?.window, { offset: 0 })
    await store.more("fixture", source)
    assert.equal(store.progress("fixture", source).loaded, 100)
  } finally { store.clear("fixture") }
})

for (const part of ["receipts", "pending"] as const) for (const text of [false, true]) test(`lifecycle ${part} ${text ? "raw" : "structured"} lane invalidates by owning control and retries the exact part`, async () => {
  const f = fixture(126403), control = f.control(), requests: MissionPanelPageRequest[] = []
  const exchange = async (body: string) => { const request = JSON.parse(body); requests.push(request); return new Response(JSON.stringify(await control.panelPage(request))) }
  let map = (await control.create({ requestID: "create-parts", objective: "Parts", template: "custom", prepared: true })).mission
  map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "start-old", action: "start" })).mission
  const store = createMissionPanelInventory({ scope: () => `control-${part}-${text}`, tasks: (_i, id, task, scope) => readMissionTaskPage(id, task, { ...scope, exchange }),
    read: (_i, selector, scope) => selector.source === "activity" || selector.source === "marks" ? Promise.reject(Error("Native unknown"))
      : readMissionPanelWindow(selector, { ...scope, exchange, runTransfer: read => read() }) })
  const key = `${text ? "text" : "field"}:${map.id}:control:${part}`
  try {
    store.setDemand("fixture", true); store.want("fixture", "selected", map.id); await store.ensure("fixture"); await store.more("fixture", key)
    assert.equal(store.progress("fixture", key).failure, undefined)
    map = (await control.lifecycle({ missionID: map.id, expectedRevision: map.revision, requestID: "pause-new", action: "pause" })).mission
    await store.refresh("fixture", false)
    assert.equal(store.state("fixture").missions[0].panelControl?.requestID, "pause-new")
    assert.equal(store.progress("fixture", key).failure, "changed")
    await store.more("fixture", key, true)
    assert.equal(store.progress("fixture", key).failure, undefined)
    const exact = requests.filter(request => request.source === "mission" && request.field === "control").at(-1)!
    assert.deepEqual(exact, { source: "mission", missionID: map.id, field: "control", ...(text ? { text: true } : {}), part, window: { offset: 0 } })
    assert.deepEqual(text ? JSON.parse(store.fieldText("fixture", map.id, `control:${part}`, 0)!) : store.fieldValues("fixture", map.id, `control:${part}`), JSON.parse(JSON.stringify(map.control![part])))
  } finally { store.clear("fixture") }
})

test("real bounded discovery bridges the existing folder completion record before seeding the project key", async () => {
  const f = fixture(126401), control = f.control(), completed = []
  for (let index = 1; index <= 3; index++) {
    const map = (await control.create({ requestID: `finished-${index}`, objective: `Finished ${index}`, template: "custom" })).mission
    completed.push((await control.report(map.coordinatorSessionId, { missionID: map.id, outcome: "completed", summary: "Done", evidence: [], next: [], final: true })).mission)
  }
  const folder = "/old-folder-real-inventory", scope = JSON.stringify([folder, f.project.id])
  markMissionsFinishedSeen(folder, [], completed.slice(0, 1)); markMissionsFinishedSeen(folder, [completed[2].id], completed)
  const store = createMissionPanelInventory({ scope: () => folder, tasks: async () => { throw Error("No task fallback") }, read: (_i, selector, scope) =>
    selector.source === "activity" || selector.source === "marks" ? Promise.reject(Error("Unknown native state")) : readMissionPanelWindow(selector, { ...scope,
      runTransfer: read => read(), exchange: async body => new Response(JSON.stringify(await control.panelPage(JSON.parse(body)))) }) })
  try {
    store.setDemand("fixture", true); await store.ensure("fixture")
    assert.deepEqual(completed.map(row => row.finishSequence), [1, 2, 3])
    assert.deepEqual(completed.map(row => missionFinishedSeen(scope, row)), [true, false, true])
  } finally { store.clear("fixture") }
})

for (const [wire, status, reason] of [[{ available: false, reason: "changed" }, "error", undefined], [{ available: false, reason: "damaged" }, "error", undefined],
  [{ available: false, reason: "plugin-failed", missions: ["malformed"] }, "error", undefined], [undefined, "error", undefined]] as const)
  test(`bounded failures keep malformed, transport and ${wire?.reason ?? "network"} separate from unavailable guidance`, async () => {
    const store = createMissionPanelInventory({ scope: () => "failure-causes", tasks: async () => { throw Error("No tasks") }, read: (_i, selector, scope) => readMissionPanelWindow(selector, {
      ...scope, runTransfer: read => read(), exchange: async () => { if (!wire) throw new TypeError("Network failure"); return new Response(JSON.stringify(wire)) } }) })
    try {
      store.setDemand("fixture", true); await store.ensure("fixture")
      assert.equal(store.state("fixture").status, status); assert.equal(store.state("fixture").reason, reason)
      assert.match(store.state("fixture").error!, new RegExp(wire?.reason === "changed" || wire?.reason === "damaged" ? wire.reason : wire ? "invalid" : "Network failure"))
    } finally { store.clear("fixture") }
  })

for (const reason of ["host-unavailable", "plugin-unavailable", "plugin-failed", "workspace-unavailable"] as const) test(`adopted bounded owner preserves ${reason} and last-good display`, async () => {
  const f = seeded(), requests: MissionPanelPageRequest[] = []
  let unavailable = true
  const store = createMissionPanelInventory({ scope: () => reason, tasks: async () => { throw Error("No task fallback") },
    read: (_i, selector, scope) => readMissionPanelWindow(selector, { ...scope, runTransfer: read => read(), exchange: async body => {
      requests.push(JSON.parse(body)); return unavailable ? new Response(JSON.stringify({ available: false, reason, missions: [] })) : f.exchange(body)
    } }) })
  try {
    store.setDemand("fixture", true); await store.ensure("fixture")
    assert.equal(store.state("fixture").status, "unavailable"); assert.equal(store.state("fixture").reason, reason)
    unavailable = false; await store.refresh("fixture"); const good = store.state("fixture").summaries
    assert.equal(good.length, 50)
    unavailable = true; await store.refresh("fixture", false)
    assert.equal(store.state("fixture").status, "unavailable"); assert.equal(store.state("fixture").reason, reason)
    assert.deepEqual(store.state("fixture").summaries, good)
    assert.ok(requests.every(request => request.source === "summaries" || request.source === "cleanups" || request.source === "marks"))
  } finally { store.clear("fixture") }
})

test("a 601-actor selected header is bounded independently of the complete map and exact wide extensions stay readable", async t => {
  const f = seeded(120, 600), before = f.scannedEntries()
  const answer = await f.read({ source: "mission", missionID: "msn_119", header: true })
  const header = answer.values[0] as { root: Record<string, unknown>; collections: Record<string, { total: number }> }
  assert.equal(header.collections.actors.total, 601)
  assert.equal(header.root.actors, undefined); assert.equal(header.root.tasks, undefined); assert.equal(header.root.control, undefined)
  assert.ok(JSON.stringify(header).length < 20_000)
  assert.equal(f.scannedEntries() - before, 1201, "one named range, no unrelated mission")
  assert.ok(f.bodies.every(bytes => bytes <= 65_536))
  t.diagnostic(`601-actor header ${f.bodies[0]} wire bytes, ${JSON.stringify(header).length} logical units, 1201 selected-range entries`)
})

test("headers retain coordinator source identity for exact ACK reconciliation and wide metadata remains an exact field", async () => {
  const f = seeded(), map = (await f.journal.missionView("msn_0")).mission!
  const document = { text: "😀\ud800".repeat(20_000), requestID: "document-sync" }
  const extended = { ...map, document, documentPending: { requestID: "pending-sync" } }, header = missionPanelHeader(extended)
  assert.equal(header.root.document, undefined)
  assert.deepEqual(header.root.documentPending, extended.documentPending)
  assert.equal(header.collections.document.digest, contentDigest(JSON.stringify(document)))
  const projected = { ...header.root, actors: header.coordinator ? [header.coordinator] : [], tasks: [], reports: [], history: [] }
  assert.equal(missionLifecycleSource("fixture", projected as never, {}), missionLifecycleSource("fixture", map, {}), "the same coordinator Location owns the full ACK and panel header")
  const field = await readMissionPanelWindow({ source: "mission", missionID: map.id, field: "document", window: { offset: 0 } }, {
    current: () => true, runTransfer: read => read(), exchange: async body => {
      const request = JSON.parse(body)
      return new Response(JSON.stringify(missionPanelWindow({ source: "mission", missionID: map.id, field: "document", projectID: map.projectID, revision: map.revision,
        discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [document], request.window, request.cursor)))
    } })
  assert.deepEqual(field.values, [document])
})

test("the selected header reads the merged unified document and preserves dormant ownership", async () => {
  const f = await preparationFixture("/fixture"), selector = { source: "mission" as const, missionID: f.mission.id, header: true as const }
  const before = await f.control.panelPage(selector)
  assert.ok(before.available)
  const header = JSON.parse(before.page.pieces.map(piece => piece.text).join(""))
  assert.deepEqual(header.root.document, (await f.control.snapshot()).missions[0].document)
  assert.ok(header.root.document?.launch)
  await f.control.configurePreparation({ ...f.request, configuration: scheduledPreparation(f) }, f.native, () => true)
  assert.deepEqual(await f.control.panelPage(selector), { available: false, reason: "mission-not-found" })
})

test("observation cycles retire old family membership without synthesizing whole-mission idle", async () => {
  const f = seeded(), map = (await f.journal.missionView("msn_119")).mission!
  let unknown = false
  const store = createMissionPanelInventory({ scope: () => "observation-cycle", tasks: async () => { throw new Error("No tasks") },
    read: (instanceId, selector, scope) => {
      if (selector.source !== "activity") return f.read(selector)
      const context = missionActivityContext(map, { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false })
      const observed = { context, coverage: unknown ? "unknown" : "observed", requests: { state: unknown ? "unknown" : "observed", items: [] },
        activity: { actors: [{ sessionId: map.coordinatorSessionId, state: "idle-without-report" }], family: { state: unknown ? "unknown" : "observed", members: [{ sessionId: "child", parentSessionId: map.coordinatorSessionId, actorSessionId: map.coordinatorSessionId, kind: "ordinary" }] } } }
      return readMissionPanelWindow(selector, { ...scope, runTransfer: read => read(), exchange: async body => new Response(JSON.stringify(missionPanelPage({ source: "activity", missionID: map.id, projectID: map.projectID, revision: map.revision,
        phase: "observed", observedAt: 1, discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [observed], JSON.parse(body).cursor))) })
    } })
  store.setDemand("fixture", true); store.want("fixture", "selected", map.id); await store.ensure("fixture")
  await store.more("fixture", `activity:${map.id}`, true)
  assert.equal(store.state("fixture").activity?.missions.find(value => value.missionId === map.id)?.family?.members.length, 1)
  unknown = true; await store.more("fixture", `activity:${map.id}`, true)
  const activity = store.state("fixture").activity!.missions.find(value => value.missionId === map.id)!
  assert.equal(activity.family?.state, "partial"); assert.deepEqual(activity.family?.members, [])
  assert.equal(activity.actors[0].state, "unknown")
  store.clear("fixture")
})

test("bounded cleanup/history adoption preserves documentPending and exact requestID extension metadata", async () => {
  const cleanup = { missionID: "msn_removed", deletionID: "evt_delete", requestID: "delete-original", expectedRevision: 17, deleteManagedSessions: true,
    objective: "Removed", createdAt: 1, removed: 0, retained: 0, pending: 0, reasons: [], documentPending: true,
    extension: { requestID: "document-request", payload: "😀\ud800".repeat(20_000) } }
  const result = await readMissionPanelWindow({ source: "cleanups", window: { offset: 0 } }, { current: () => true, runTransfer: read => read(), exchange: async body => {
    const request = JSON.parse(body)
    return new Response(JSON.stringify(missionPanelWindow({ source: "cleanups", projectID: "project", discardedEvents: 0,
      controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [cleanup], request.window, request.cursor)))
  } })
  assert.deepEqual(panelCleanupSchema.parse(result.values[0]), cleanup)
  const history = { revision: 2, createdAt: 1, requestID: "history-original", bodies: {} }
  assert.deepEqual(panelHistorySchema.parse(history), history)
})

test("raw field windows preserve surrogate boundaries and exact JSON without whole-field assembly", async () => {
  const value = { extension: "x".repeat(32753) + "😀\ud800".repeat(50_000) }, text = JSON.stringify(value)
  const header = { source: "mission" as const, missionID: "msn_raw", field: "extension", projectID: "project", revision: 1,
    discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
  const chunks: string[] = []
  let order: string | undefined, total = 1
  for (let offset = 0; offset < total; offset++) {
    const answer = await readMissionPanelWindow({ source: "mission", missionID: "msn_raw", field: "extension", text: true, window: { offset, order } }, {
      current: () => true, runTransfer: read => read(), exchange: async body => {
        const selector = JSON.parse(body), result = missionPanelTextWindow(header, value, selector.window, selector.cursor)
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536)
        return new Response(JSON.stringify(result))
      } })
    order = answer.envelope.window!.order; total = answer.envelope.window!.total
    const chunk = answer.values[0] as string
    assert.ok(chunk.length <= 32769); assert.ok(!/[\uD800-\uDBFF]$/.test(chunk)); assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk))
    chunks.push(chunk)
  }
  assert.equal(chunks.join(""), text); assert.equal(order, contentDigest(text))
  assert.deepEqual(missionPanelTextWindow(header, { changed: true }, { offset: 1, order }), { available: false, reason: "changed" })
  const f = seeded(120, 600)
  const raw = await f.read({ source: "mission", missionID: "msn_119", field: "actors", text: true, window: { offset: 0 } })
  assert.equal(typeof raw.values[0], "string"); assert.ok(raw.envelope.window!.total > 300)
})

test("control receipt parts are independently pageable without shadowing unknown root metadata", async () => {
  const f = fixture(4267), control = f.control()
  const created = (await control.create({ requestID: "control-parts", objective: "Control parts", template: "custom", prepared: true })).mission
  await control.lifecycle({ missionID: created.id, expectedRevision: created.revision, requestID: "start-parts", action: "start" })
  const map = (await f.journal.missionView(created.id)).mission!, extension = { retained: "exact unknown metadata" }
  const header = missionPanelHeader({ ...map, controlReceipts: extension } as typeof map)
  assert.deepEqual(header.root.controlReceipts, extension)
  const result = await control.panelPage({ source: "mission", missionID: map.id, field: "control", part: "receipts", window: { offset: 0 } })
  assert.ok(result.available); assert.equal(result.part, "receipts"); assert.equal(result.window?.total, 1)
  assert.deepEqual(JSON.parse(result.page.pieces[0].text), JSON.parse(JSON.stringify(map.control!.receipts![0])))
})

test("bounded cleanup discovery traverses every pending intent beyond the compatibility display limit", async () => {
  const f = fixture(4268)
  for (let index = 0; index < 2101; index++) {
    const missionID = `msn_cleanup_${index}`
    const events = [{ id: "evt_created", type: "mission.created", projectCanonical: "/repo", objective: "Pending cleanup", template: "custom",
      coordinator: { sessionID: `ses_${index}`, title: "Coordinator", location: f.project.location }, createdAt: index + 1 },
    { id: "evt_deleted", type: "mission.deleted", requestID: `delete_${index}`, expectedRevision: 1, deleteManagedSessions: true,
      cleanupTargets: [{ sessionID: `ses_pending_${index}`, location: f.project.location }], createdAt: index + 3000 }]
    for (const input of events) {
      const event = parseMissionEvent({ version: 1, projectID: f.project.id, missionID, ...input }); assert.ok(event)
      f.tamper(`${f.prefix}/${missionID}/${event.id}`, event as never)
    }
  }
  const control = f.control(), first = await control.panelPage({ source: "cleanups", window: { offset: 0 } })
  assert.ok(first.available); assert.equal(first.window!.total, 2101)
  const before = f.scannedEntries(), ids = new Set(first.page.pieces.map(piece => { const row = JSON.parse(piece.text); return JSON.stringify([row.missionID, row.deletionID]) }))
  for (let offset = first.window!.end; offset < first.window!.total;) {
    const next = await control.panelPage({ source: "cleanups", window: { offset, order: first.window!.order } })
    assert.ok(next.available); assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 65536)
    for (const piece of next.page.pieces) { const row = JSON.parse(piece.text); ids.add(JSON.stringify([row.missionID, row.deletionID])) }
    offset = next.window!.end
  }
  assert.equal(ids.size, 2101); assert.equal(f.scannedEntries(), before)
})

test("initial discovery returns the durable counter across deletion gaps and never substitutes live summary maxima", async () => {
  const f = fixture(4265), control = f.control()
  for (let index = 0; index < 2; index++) {
    const created = (await control.create({ requestID: `create-${index}`, objective: "Finish", template: "custom" })).mission
    const ended = (await control.report(created.coordinatorSessionId, { missionID: created.id, outcome: "completed", summary: "Done", evidence: [], next: [], final: true })).mission
    if (index === 1) await control.delete({ missionID: ended.id, requestID: "delete", expectedRevision: ended.revision })
  }
  const answer = await control.panelPage({ source: "summaries", initial: true, window: { offset: 0 } })
  assert.ok(answer.available); assert.equal(answer.finishHighWater, 2)
  assert.equal(JSON.parse(answer.page.pieces[0].text).finishSequence, 1)
  f.values.set(missionFinishCounterKey(f.journal.projectToken), { damaged: true })
  await assert.rejects(control.panelPage({ source: "summaries", initial: true, window: { offset: 0 } }), /counter is damaged/)
})

test("a new finish during actual multi-window discovery stays unseen after changed-order restart; deleted finish numbers remain in the initial seed", async () => {
  const f = seeded()
  for (let index = 0; index < 2; index++) await f.journal.appendFinish({ version: 1, projectID: f.project.id, missionID: `msn_${119 - index}`, id: "evt_finished", type: "mission.finished", outcome: "completed", summary: "Historical", createdAt: 1000 + index })
  await f.journal.append({ version: 1, projectID: f.project.id, missionID: "msn_118", id: "evt_deleted", type: "mission.deleted", requestID: "delete-finish-2", expectedRevision: 2, createdAt: 1002 })
  const store = createMissionPanelInventory({ scope: () => "discovery-finish-race", tasks: async () => { throw new Error("No wanted tasks") },
    read: (_instance, selector, scope) => {
      if (selector.source === "marks" || selector.source === "activity") return Promise.reject(new Error("Native unknown"))
      return readMissionPanelWindow(selector, { ...scope, exchange: f.exchange, runTransfer: read => read() })
    } })
  store.setDemand("fixture", true); await store.ensure("fixture")
  const scope = JSON.stringify(["discovery-finish-race", f.project.id])
  assert.equal(missionFinishedSeen(scope, { id: "msn_119", finishSequence: 1 }), true)
  assert.equal(missionFinishedSeen(scope, { id: "msn_118", finishSequence: 2 }), true)
  await f.journal.appendFinish({ version: 1, projectID: f.project.id, missionID: "msn_117", id: "evt_finished", type: "mission.finished", outcome: "completed", summary: "New during traversal", createdAt: 4 })
  await store.more("fixture", "summaries")
  assert.equal(store.progress("fixture", "summaries").failure, "changed")
  assert.equal(store.state("fixture").summaries.length, 50, "the previous complete window stays displayed")
  await store.more("fixture", "summaries", true); await store.more("fixture", "summaries"); await store.more("fixture", "summaries")
  assert.equal(store.progress("fixture", "summaries").loaded, 119)
  assert.equal(missionFinishedSeen(scope, { id: "msn_117", finishSequence: 3 }), false)
  assert.equal(f.selectors.filter(selector => selector.source === "summaries" && selector.initial).length, 1, "never re-seed after later discovery")
  store.clear("fixture")
})

test("the adopted store loads only wanted headers; failed-middle inventory stays parked and retained through unrelated successes", async () => {
  const f = seeded(), nativeReads: string[] = []
  let failMiddle = false
  const store = createMissionPanelInventory({ scope: () => "inventory-contract", tasks: async (_instance, id, task, scope) => readMissionTaskPage(id, task, { ...scope, exchange: f.exchange }),
    read: async (_instance, selector, scope) => {
      if (selector.source === "activity" || selector.source === "marks") { nativeReads.push(selector.source); throw new Error("Native unknown") }
      if (selector.source === "summaries" && selector.window?.offset === 50 && failMiddle) throw new Error("Middle unavailable")
      return readMissionPanelWindow(selector, { ...scope, exchange: f.exchange, runTransfer: read => read() })
    } })
  store.setDemand("fixture", true); await store.ensure("fixture")
  assert.equal(store.state("fixture").summaries.length, 50); assert.equal(store.state("fixture").missions.length, 0)
  assert.ok(f.selectors.every(selector => selector.source === "summaries" || selector.source === "cleanups"))
  failMiddle = true; await store.more("fixture", "summaries")
  assert.equal(store.progress("fixture", "summaries").failure, "failed")
  await store.more("fixture", "cleanups")
  assert.equal(store.progress("fixture", "summaries").failure, "failed")
  store.want("fixture", "reader", "msn_119", true); await store.refresh("fixture")
  assert.deepEqual(store.state("fixture").missions.map(map => map.id), ["msn_119"])
  assert.ok(f.selectors.filter(selector => selector.source === "mission").every(selector => selector.missionID === "msn_119"))
  failMiddle = false; await store.more("fixture", "summaries", true); await store.more("fixture", "summaries")
  assert.equal(store.progress("fixture", "summaries").loaded, 120)
  assert.equal(store.progress("fixture", "summaries").failure, undefined)
  store.want("fixture", "reader", undefined); store.setDemand("fixture", false); store.clear("fixture")
})

test("inventory header lifetimes survive concurrent owners but last-owner A→B→A never publishes the held old header", async () => {
  const f = seeded()
  let entered!: () => void, release!: () => void, headerReads = 0, oldCurrent!: () => boolean
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const store = createMissionPanelInventory({ scope: () => "inventory-owners", tasks: async (_instance, id, request, scope) => readMissionTaskPage(id, request, { ...scope, exchange: f.exchange }),
    read: async (_instance, selector, scope) => {
      if (selector.source === "activity" || selector.source === "marks") throw new Error("Native unavailable")
      return readMissionPanelWindow(selector, { ...scope, runTransfer: read => read(), exchange: async body => {
        if (selector.source === "mission" && selector.header && ++headerReads === 1) { oldCurrent = scope.current; entered(); await gate }
        return f.exchange(body)
      } })
    } })
  store.setDemand("fixture", true); await store.ensure("fixture")
  store.want("fixture", "selection", "msn_119")
  await started
  store.want("fixture", "reader", "msn_119", true)
  store.want("fixture", "selection", undefined)
  assert.equal(oldCurrent(), true, "the concurrent reader preserves this lifetime")
  store.want("fixture", "reader", undefined)
  store.want("fixture", "selection", "msn_119")
  try {
    assert.equal(oldCurrent(), false)
    await store.refresh("fixture")
    assert.equal(headerReads, 2, "one fresh owned read without releasing the stale transport")
    assert.deepEqual(store.state("fixture").missions.map(map => map.id), ["msn_119"])
  } finally { release(); store.clear("fixture") }
})

test("a logical directory window keeps its admission deadline while another window occupies its serialized lane", async () => {
  const f = seeded()
  let hold = false, entered!: () => void, release!: () => void, deadline50 = 0
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const store = createMissionPanelInventory({ scope: () => "queued-window-deadline", tasks: async () => { throw new Error("No tasks") },
    read: async (_instance, selector, scope) => {
      if (selector.source === "marks" || selector.source === "activity") throw new Error("Native unknown")
      if (selector.source === "summaries" && selector.window?.offset === 0 && hold) { hold = false; entered(); await gate }
      if (selector.source === "summaries" && selector.window?.offset === 50) deadline50 = scope.deadline!
      return readMissionPanelWindow(selector, { ...scope, exchange: f.exchange, runTransfer: read => read() })
    } })
  store.setDemand("fixture", true); await store.ensure("fixture")
  hold = true; const refreshing = store.refresh("fixture")
  await started
  const requestedAt = performance.now(), further = store.more("fixture", "summaries")
  try {
    await new Promise(resolve => setTimeout(resolve, 120)); release()
    await Promise.all([refreshing, further])
    assert.ok(deadline50 >= requestedAt + 29_995 && deadline50 <= requestedAt + 30_005, "the queue wait never starts a fresh 30-second lifetime")
    assert.equal(store.progress("fixture", "summaries").loaded, 100)
  } finally { release(); store.clear("fixture") }
})

test("an unrelated root revision rereads no expanded task windows or task transport", async t => {
  const f = seeded(120, 80)
  const store = createMissionPanelInventory({ scope: () => "unchanged-task-sources", tasks: async (_instance, id, request, scope) => readMissionTaskPage(id, request, { ...scope, exchange: f.exchange }),
    read: (_instance, selector, scope) => selector.source === "marks" || selector.source === "activity" ? Promise.reject(new Error("Native unknown"))
      : readMissionPanelWindow(selector, { ...scope, exchange: f.exchange, runTransfer: read => read() }) })
  store.setDemand("fixture", true); store.want("fixture", "selection", "msn_119"); await store.ensure("fixture")
  assert.equal(await store.loadTasks("fixture", "msn_119", { offset: 50 }), "read")
  const tasksBefore = f.selectors.filter(selector => selector.source === "tasks").length, headersBefore = f.selectors.filter(selector => selector.source === "mission").length
  const map = (await f.journal.missionView("msn_119")).mission!, scans = f.fullScans()
  await f.journal.append({ version: 1, projectID: f.project.id, missionID: map.id, id: "evt_notes_only", type: "mission.updated", requestID: "notes-only", expectedRevision: map.revision,
    objective: map.objective, notesSpecified: true, notes: "Unrelated root notes", createdAt: 10_000 })
  await store.refresh("fixture")
  assert.equal(f.selectors.filter(selector => selector.source === "tasks").length, tasksBefore)
  assert.equal(f.selectors.filter(selector => selector.source === "mission").length, headersBefore + 1)
  assert.equal(f.fullScans(), scans)
  t.diagnostic("notes-only revision: 1 wanted header, 0 task transfers, 0 expanded task rereads, 0 full scans")
  store.clear("fixture")
})

test("selected header assembly refuses oversized advertised data before hashing or allocation", async () => {
  const f = seeded(), map = (await f.journal.missionView("msn_0")).mission!, header = missionPanelHeader(map)
  Object.assign(header.root, { oversized: "x".repeat(1024 * 1024) })
  let hashes = 0
  const original = crypto.subtle.digest.bind(crypto.subtle)
  crypto.subtle.digest = (...args) => { hashes++; return original(...args) }
  try {
    await assert.rejects(readMissionPanelWindow({ source: "mission", missionID: map.id, header: true }, { current: () => true, runTransfer: read => read(),
      exchange: async body => new Response(JSON.stringify(missionPanelPage({ source: "mission", missionID: map.id, projectID: map.projectID, revision: map.revision, header: true,
        discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [header], JSON.parse(body).cursor))) }), { reason: "too-large" })
    assert.equal(hashes, 0)
  } finally { crypto.subtle.digest = original }
})

for (const poison of ["id", "projectID", "coordinator"] as const) test(`a correctly hashed foreign ${poison} header is never adopted`, async () => {
  const f = seeded(), map = (await f.journal.missionView("msn_119")).mission!
  const header = missionPanelHeader(map)
  if (poison === "coordinator") header.coordinator!.sessionId = "foreign-coordinator"
  else header.root[poison] = "foreign"
  const store = createMissionPanelInventory({ scope: () => `foreign-header-${poison}`, tasks: async (_instance, id, request, scope) => readMissionTaskPage(id, request, { ...scope, exchange: f.exchange }),
    read: (_instance, selector, scope) => {
      if (selector.source === "activity" || selector.source === "marks") return Promise.reject(new Error("Native unknown"))
      return readMissionPanelWindow(selector, { ...scope, runTransfer: read => read(), exchange: async body => selector.source === "mission" && selector.header
        ? new Response(JSON.stringify(missionPanelPage({ source: "mission", missionID: map.id, projectID: map.projectID, revision: map.revision, header: true,
          discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [header], JSON.parse(body).cursor))) : f.exchange(body) })
    } })
  store.setDemand("fixture", true); store.want("fixture", "selection", map.id); await store.ensure("fixture")
  assert.equal(store.state("fixture").status, "error"); assert.deepEqual(store.state("fixture").missions, [])
  store.clear("fixture")
})

for (const status of [200, 503]) test(`actual inventory API releases deferred ${status} cleanup slots at the logical deadline`, async t => {
  const { serverApi } = await import("../../src/lib/api-client"), { backgroundReads } = await import("../../src/lib/background-read-queue")
  const original = globalThis.fetch
  let reject!: (error: Error) => void, cancelled = 0, starts = 0, released = false
  const gate = new Promise<void>((_, rejectGate) => { reject = rejectGate }), keepAlive = setTimeout(() => {}, 3000), deadline = performance.now() + 150
  const dispatched: Array<{ at: number; aborted: boolean }> = []
  globalThis.fetch = async (_input, init) => { starts++; dispatched.push({ at: performance.now(), aborted: init?.signal?.aborted === true }); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel() { cancelled++; return gate } }), { status }) }
  const calls = Array.from({ length: 3 }, () => serverApi.fetchMissionPanel("fixture", { source: "summaries", window: { offset: 0 } }, { current: () => true, deadline }))
  let markerBeforeRelease = false
  const marker = backgroundReads.run(AbortSignal.timeout(1000), async () => { markerBeforeRelease = !released && performance.now() >= deadline }).then(() => true, () => false)
  try {
    const results = await Promise.allSettled(calls)
    assert.equal(await marker, true); assert.equal(markerBeforeRelease, true)
    t.diagnostic(JSON.stringify({ deadline, dispatched, starts, cancelled }))
    // Independent native timers can release a slot just before the absolute
    // deadline. A third dispatch is valid only while its own admission is live.
    assert.ok(starts >= 2 && starts <= 3)
    assert.equal(cancelled, starts)
    assert.ok(dispatched.every(read => !read.aborted && read.at < deadline), "no queued transfer starts at/after its original deadline")
    assert.ok(results.every(result => result.status === "rejected"))
  } finally {
    released = true; reject(new Error("Late inventory cancel rejection"))
    await Promise.allSettled(calls); await marker; await backgroundReads.run(new AbortController().signal, async () => {})
    globalThis.fetch = original; clearTimeout(keepAlive)
  }
})
