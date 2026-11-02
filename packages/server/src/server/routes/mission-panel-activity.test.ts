import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { missionPluginFixture, FIXTURE_PROJECT } from "../../missions/mission-plugin-fixture"
import { MissionJournal, parseMissionEvent } from "../../missions/journal"
import { runMissionExclusive } from "../../missions/exclusive"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { missionPanelPageRequestSchema, type MissionPanelPageResult, type MissionPanelCursor } from "../../missions/mission-panel-page"
import type { MissionPanelActivityObservation } from "../../missions/mission-panel-observation"
import type { MissionJsonValue } from "../../missions/model"
import { contentDigest } from "../../missions/content-digest"

/** Real journal, plugin handler, HTTP seam and activity pipeline; only the native service
 * is deterministic. No task/map reconstruction or feature logic is copied into the test. */
async function fixture(conflictingActorLocation = false) {
  const f = missionPluginFixture(), journal = new MissionJournal(f.storage, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical)
  const location = FIXTURE_PROJECT.location, scans: string[] = [], scan = f.storage.scan.bind(f.storage)
  f.storage.scan = async input => { scans.push(input.prefix); return scan(input) }
  const seed = (missionID: string, value: Record<string, unknown>) => {
    const parsed = parseMissionEvent({ version: 1, projectID: FIXTURE_PROJECT.id, missionID, ...value })
    assert.ok(parsed, JSON.stringify(value))
    f.values.set(`codenomad-missions/v2/${journal.projectToken}/${missionID}/${parsed.id}`, parsed as never)
  }
  const parents = new Map<string, string>(), active = new Set<string>(), forms: any[] = [], permissions: any[] = []
  for (let index = 0; index < 50; index++) {
    const missionID = `msn_activity_${index}`, coordinator = `ses_c_${conflictingActorLocation && index === 48 ? 49 : index}`
    seed(missionID, { id: "evt_created", type: "mission.created", projectCanonical: "/repo", objective: `Mission ${index}`, template: "custom",
      coordinator: { sessionID: coordinator, title: coordinator, location: conflictingActorLocation && index === 48 ? { directory: "/other" } : location }, createdAt: index + 1 })
    if (index >= 25) seed(missionID, { id: "evt_done", type: "mission.finished", outcome: "completed", summary: "Done", createdAt: index + 100 })
  }
  for (let index = 0; index < 190; index++) {
    const taskKey = `work-${index}`, sessionID = `ses_a_${index}`
    const binding = { generation: 1, parentSessionID: "ses_c_0", parentMessageID: `msg_${index}`, toolCallID: `call_${index}` }
    parents.set(sessionID, "ses_c_0")
    seed("msn_activity_0", { id: `evt_task_${index}`, type: "task.created", task: { id: `tsk_${index}`, key: taskKey, title: taskKey, brief: "Brief",
      role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }, createdAt: 1_000 + index * 3 })
    seed("msn_activity_0", { id: `evt_bound_${index}`, type: "task.native-bound", taskKey, binding,
      actor: { sessionID, title: `Actor ${index}`, managed: true, location }, createdAt: 1_001 + index * 3 })
    seed("msn_activity_0", { id: `evt_end_${index}`, type: "task.native-call-ended", taskKey, binding, childSessionID: sessionID,
      outcome: "returned", createdAt: 1_002 + index * 3 })
  }
  parents.set("ses_grandchild", "ses_a_189")
  forms.push({ id: "form_far", sessionID: "ses_a_189", title: "Far question", fields: [] })
  permissions.push({ id: "permission_child", sessionID: "ses_grandchild", action: "bash", resources: ["git status"] })
  const calls: string[] = [], responseBytes: number[] = [], fail = new Set<string>(), foreign = new Set<string>()
  let current = true, hook: (() => Promise<void>) | undefined
  const session = (id: string) => ({ id, projectID: foreign.has(id) ? "foreign" : FIXTURE_PROJECT.id, location,
    ...(parents.has(id) ? { parentID: parents.get(id) } : {}) })
  const client = {
    location: { get: async () => ({ directory: "/repo", project: { id: FIXTURE_PROJECT.id } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`get:${sessionID}`)
        if (hook) { const own = hook; hook = undefined; await own() }
        if (fail.has("get")) throw new Error("No session capability")
        return session(sessionID)
      },
      list: async ({ parentID, limit }: { parentID: string; limit: number }) => {
        calls.push(`children:${parentID}`)
        if (fail.has("children")) throw new Error("Incomplete family")
        return { data: [...parents].filter(([, parent]) => parent === parentID).slice(0, limit).map(([id]) => session(id)), cursor: { next: null } }
      },
      active: async () => { calls.push("active"); if (fail.has("active")) throw new Error("No active capability"); return Object.fromEntries([...active].map(id => [id, { type: "running" }])) },
      inbox: { list: async ({ sessionID }: { sessionID: string }) => { calls.push(`inbox:${sessionID}`); if (fail.has("inbox")) throw new Error("No inbox"); return [] } },
    },
    shell: { list: async () => { calls.push("shells"); if (fail.has("shells")) throw new Error("No shell capability"); return { location, data: [] } } },
    form: { list: async () => { calls.push("forms"); if (fail.has("forms")) throw new Error("No form capability"); return { location, data: forms } } },
    permission: { request: { list: async () => { calls.push("permissions"); if (fail.has("permissions")) throw new Error("No permission capability"); return { location, data: permissions } } } },
    rpc: () => ({ panelPage: async (input: unknown) => plugin.rpc("panelPage", input) }),
  }
  const plugin = await f.plugin(), workspace = { id: "workspace" }, app = Fastify({ logger: false })
  registerMissionRoutes(app, { worktreeDeletionFence: new WorktreeDeletionFence(), workspaceManager: {
    get: () => workspace, getServiceLocation: () => location, ownsLocation: async () => true, getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getSharedServiceConnection: async () => ({ client, assertCurrent() { if (!current) throw new Error("Stale connection") } }) } as never })
  const read = async (input: object): Promise<MissionPanelPageResult> => {
    const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/panel-page", payload: input })
    responseBytes.push(response.rawPayload.length)
    assert.ok(response.rawPayload.length <= 65_536, `${response.rawPayload.length} bytes`)
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }
  const whole = async (input: object) => {
    let cursor: MissionPanelCursor | undefined, text = "", transfers = 0
    do {
      const result = await read({ ...input, ...(cursor ? { cursor } : {}) })
      assert.ok(result.available, JSON.stringify(result))
      assert.equal(result.phase, "observed")
      for (const piece of result.page.pieces) { assert.equal(piece.index, 0); assert.equal(piece.offset, text.length); text += piece.text }
      cursor = result.page.next; transfers++
      assert.ok(transfers < 100)
    } while (cursor)
    return { value: JSON.parse(text), transfers }
  }
  return { ...f, app, plugin, journal, scans, calls, responseBytes, fail, foreign, forms, permissions, active, read, whole,
    hook: (value: () => Promise<void>) => { hook = value }, stale: () => { current = false }, close: async () => { await app.close(); await plugin.dispose() } }
}

test("marks traverse open and closed missions from warm hints without range fan-out; off-page actor attention is reachable within native budgets", async t => {
  const f = await fixture()
  try {
    await new Promise(resolve => setImmediate(resolve)) // finish the plugin's independent startup outbox read
    await f.plugin.rpc("panelPage", { source: "marks" }) // normal hint warmup
    f.scans.length = 0
    const seen: string[] = []
    for (let missionOffset = 0; ; ) {
      const { value } = await f.whole({ source: "marks", missionOffset })
      seen.push(...value.observations.map((item: MissionPanelActivityObservation) => item.context.id))
      if (value.missionPage.end === value.missionPage.total) break
      missionOffset = value.missionPage.end
    }
    assert.equal(new Set(seen).size, 50)
    assert.equal(f.scans.length, 0, "no warm project or open-range reads")
    f.calls.length = 0; f.scans.length = 0
    const first = (await f.whole({ source: "activity", missionID: "msn_activity_0" })).value as MissionPanelActivityObservation
    assert.deepEqual(first.context.actorPage, { order: first.context.actorPage.order, offset: 0, end: 160, total: 191 })
    assert.notEqual(first.requests.state, "observed", "no claim of complete absence outside the window")
    assert.equal(first.requests.items.length, 0)
    assert.ok(f.calls.filter(call => call.startsWith("get:")).length <= 160, "160 actor roots, no extra ancestry for this fixture")
    f.calls.length = 0; f.scans.length = 0
    const second = (await f.whole({ source: "activity", missionID: "msn_activity_0", actorOffset: 160, actorOrder: first.context.actorPage.order })).value as MissionPanelActivityObservation
    assert.deepEqual(second.context.actorPage, { order: first.context.actorPage.order, offset: 160, end: 191, total: 191 })
    assert.equal(second.coverage, "partial")
    assert.deepEqual(second.requests.items.map(item => [item.kind, item.request.id, item.actorSessionId]),
      [["form", "form_far", "ses_a_189"], ["permission", "permission_child", "ses_a_189"]])
    assert.equal(second.activity.actors.find(actor => actor.sessionId === "ses_a_189")?.state, "permission")
    assert.equal(second.context.actors.find(actor => actor.sessionId === "ses_a_189")?.taskContext?.taskKey, "work-189")
    assert.equal(second.activity.family.members.find(member => member.sessionId === "ses_grandchild")?.kind, undefined, "classification outside a partial actor window stays unspecified")
    assert.ok(f.scans.every(prefix => prefix.endsWith("/msn_activity_0/")), "only the requested range")
    t.diagnostic(`off-page window: ${JSON.stringify(Object.fromEntries(["get:", "children:", "inbox:", "active", "forms", "permissions"].map(prefix => [prefix, f.calls.filter(call => call.startsWith(prefix)).length])))}`)
  } finally { await f.close() }
})

test("mark request attribution matches each context's saved Location even when actor IDs overlap", async () => {
  const f = await fixture(true)
  try {
    f.forms.push({ id: "shared_actor", sessionID: "ses_c_49", title: "Owned question", fields: [] })
    const { value } = await f.whole({ source: "marks" })
    const valid = value.observations.find((item: MissionPanelActivityObservation) => item.context.id === "msn_activity_49")
    const moved = value.observations.find((item: MissionPanelActivityObservation) => item.context.id === "msn_activity_48")
    assert.equal(valid.requests.items[0].request.id, "shared_actor")
    assert.deepEqual([moved.requests.state, moved.requests.items, moved.activity.actors[0].state], ["unknown", [], "unknown"])
  } finally { await f.close() }
})

test("failed capabilities, foreign roots, global requests and partial families stay unknown; positive own attention survives unrelated capability failure", async () => {
  const f = await fixture()
  try {
    for (const capability of ["active", "children", "inbox", "shells"]) {
      f.fail.add(capability)
      const { value } = await f.whole({ source: "activity", missionID: "msn_activity_0", actorOffset: 160 })
      assert.equal(value.coverage, "unknown", capability)
      assert.notEqual(value.requests.state, "observed", capability)
      assert.equal(value.activity.actors.find((actor: any) => actor.sessionId === "ses_a_160").state, "unknown", "failure is never idle-without-report")
      assert.ok(value.requests.items.some((item: any) => item.request.id === "form_far"), "validated own request remains exposed")
      f.fail.clear()
    }
    f.fail.add("forms"); f.fail.add("permissions")
    const absent = (await f.whole({ source: "activity", missionID: "msn_activity_0", actorOffset: 160 })).value
    assert.deepEqual([absent.requests.state, absent.requests.items], ["unknown", []])
    const one = (await f.whole({ source: "activity", missionID: "msn_activity_1" })).value
    assert.deepEqual([one.requests.state, one.requests.items], ["unknown", []], "even a whole actor window cannot claim absence after a failed request read")
    f.fail.clear(); f.foreign.add("ses_a_189")
    const foreign = (await f.whole({ source: "activity", missionID: "msn_activity_0", actorOffset: 160 })).value
    assert.equal(foreign.requests.items.length, 0)
    f.foreign.clear(); f.permissions.push({ id: "global", sessionID: "global", action: "bash", resources: [] })
    const global = (await f.whole({ source: "activity", missionID: "msn_activity_1" })).value
    assert.equal(global.requests.state, "unknown")
    assert.equal(global.requests.items.length, 0)
    f.hook(async () => { f.stale() })
    assert.deepEqual(await f.read({ source: "activity", missionID: "msn_activity_1" }), { available: false, reason: "observation-unavailable" })
  } finally { await f.close() }
})

test("volatile pieces reconstruct one exact observation or refuse changed; native IO runs after append exclusion", async t => {
  const f = await fixture()
  try {
    // Taking the append lane from inside native IO would deadlock if journal observation held it.
    f.hook(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([runMissionExclusive(`append:${f.journal.projectToken}`, async () => {}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native IO held append lock")), 2_000) })]) }
      finally { clearTimeout(timer) }
    })
    const plain = await f.read({ source: "activity", missionID: "msn_activity_1" })
    assert.ok(plain.available)
    assert.equal(JSON.parse(plain.page.pieces[0].text).coverage, "observed")
    for (let index = 0; index < 800; index++) f.forms.push({ id: `form_${index}`, sessionID: "ses_c_1", title: "Question \u0000😀".repeat(80), fields: [] })
    const first = await f.read({ source: "activity", missionID: "msn_activity_1" })
    assert.ok(first.available && first.page.next)
    const stable = await f.whole({ source: "activity", missionID: "msn_activity_1" })
    assert.ok(stable.transfers > 1)
    assert.equal(stable.value.requests.items.length, 800)
    t.diagnostic(`800 exact requests: ${stable.transfers} transfers; maximum actual HTTP body ${Math.max(...f.responseBytes)} bytes`)
    f.forms.push({ id: "new", sessionID: "ses_c_1", title: "New question", fields: [] })
    assert.deepEqual(await f.read({ source: "activity", missionID: "msn_activity_1", cursor: first.page.next }), { available: false, reason: "changed" })
    assert.equal(missionPanelPageRequestSchema.safeParse({ source: "activity", missionID: "msn_activity_1", actorOffset: -1 }).success, false)
    f.calls.length = 0
    assert.deepEqual(await f.read({ source: "activity", missionID: "msn_activity_1", actorOrder: "x".repeat(43) }), { available: false, reason: "changed" })
    assert.deepEqual(await f.read({ source: "marks", missionOrder: "x".repeat(43) }), { available: false, reason: "changed" })
    assert.equal(f.calls.length, 0, "stale actor/mission orders refuse before native IO")
  } finally { await f.close() }
})

test("invalid plugin contexts retain bounded plugin-unavailable semantics and cause no native observation", async () => {
  const f = await fixture(), original = f.plugin.rpc
  try {
    for (const poisoned of ["foreign", "phase", "actors"]) {
      f.plugin.rpc = async (method, input) => {
        const result = await original(method, input)
        if (poisoned === "foreign") return { ...result, projectID: "foreign" }
        if (poisoned === "phase") return { ...result, phase: "observed" }
        const context = JSON.parse(result.page.pieces[0].text)
        context.actors = Array(161).fill(context.actors[0]); context.actorPage.end = 161; context.actorPage.total = 161
        const text = JSON.stringify(context)
        return { ...result, page: { ...result.page, digest: contentDigest(`[${text}]`), pieces: [{ index: 0, offset: 0, characters: text.length, text }] } }
      }
      const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/panel-page", payload: { source: "activity", missionID: "msn_activity_1" } })
      assert.deepEqual([response.statusCode, response.json()], [502, { available: false, reason: "plugin-unavailable", missions: [] }])
      assert.ok(response.rawPayload.length < 100)
      assert.equal(f.calls.length, 0)
    }
  } finally { f.plugin.rpc = original; await f.close() }
})

test("context assembly pins the first collection, length and provenance before any native IO", async t => {
  for (const poison of ["digest", "next-digest", "characters", "mixed-context", "marks-header", "revision", "duplicate-marks",
    "missing-discardedEvents", "missing-controlUnavailable", "missing-notificationUnavailable", "missing-cleanupUnavailable", "stable"]) {
    await t.test(poison, async () => {
      const f = await fixture(), original = f.plugin.rpc
      let reads = 0
      try {
        const source = poison.includes("marks") || poison.startsWith("missing-") ? "marks" : "activity"
        const request = { source, ...(source === "activity" ? { missionID: "msn_activity_1" } : {}) }
        f.plugin.rpc = async (method, raw) => {
          const input = missionPanelPageRequestSchema.parse(raw)
          // Alter only real registered-producer output. Fresh reads let the fault seam
          // model a producer following its own forged next digest, rather than refusing it.
          const result = await original(method, { ...input, cursor: undefined })
          assert.ok(result.available && result.page.pieces.length === 1 && !result.page.next)
          reads++
          let text = result.page.pieces[0].text
          const value = JSON.parse(text)
          if (poison === "duplicate-marks") {
            value.contexts[1] = value.contexts[0]
            text = JSON.stringify(value)
          }
          if (poison === "revision") { value.revision++; text = JSON.stringify(value) }
          let digest = contentDigest(`[${text}]`), end = Math.floor(text.length / 2)
          if (poison === "mixed-context") {
            const a = structuredClone(value), b = structuredClone(value)
            a.actors[0].title = "first"; b.actors[0].title = "other"; b.discardedEvents = 1
            const aText = JSON.stringify(a), bText = JSON.stringify(b)
            assert.equal(aText.length, bText.length)
            end = aText.indexOf(',"discardedEvents"')
            const mixed = aText.slice(0, end) + bText.slice(end)
            assert.notDeepEqual(JSON.parse(mixed), a); assert.notDeepEqual(JSON.parse(mixed), b)
            digest = contentDigest(`[${aText}]`)
            text = input.cursor ? bText : aText
            if (input.cursor) result.discardedEvents = 1
          }
          if (poison === "marks-header" && input.cursor) result.discardedEvents++
          if (poison === "revision" && input.cursor) result.revision++
          if (poison.startsWith("missing-")) delete result[poison.slice("missing-".length)]
          const split = ["next-digest", "characters", "mixed-context", "marks-header", "revision", "stable"].includes(poison)
          const offset = split && input.cursor ? end : 0
          if (poison === "digest" || poison === "next-digest" && input.cursor) digest = "x".repeat(43)
          return { ...result, page: { digest, total: 1, pieces: [{ index: 0, offset,
            characters: text.length + (poison === "characters" && !input.cursor ? 100 : 0),
            text: text.slice(offset, split && !input.cursor ? end : undefined) }],
            ...(split && !input.cursor ? { next: { digest: poison === "next-digest" ? "x".repeat(43) : digest, index: 0, offset: end } } : {}),
          } }
        }
        const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/panel-page", payload: request })
        if (poison === "stable") {
          assert.deepEqual([response.statusCode, response.json().phase, reads, f.calls.length], [200, "observed", 2, 7])
        } else {
          assert.deepEqual([response.statusCode, response.json().reason, f.calls.length], [502, "plugin-unavailable", 0])
          assert.deepEqual(response.json(), { available: false, reason: "plugin-unavailable", missions: [] })
          assert.equal(response.rawPayload.length, 63)
          if (poison === "next-digest") assert.equal(reads, 1, "reject a switched next digest before requesting it")
        }
      } finally { f.plugin.rpc = original; await f.close() }
    })
  }
})

test("business completion, graceful Pause and pending receipts remain separate from observed native work; range damage survives live envelopes", async () => {
  const f = await fixture()
  try {
    f.active.add("ses_c_49")
    const closed = (await f.whole({ source: "activity", missionID: "msn_activity_49" })).value
    assert.deepEqual([closed.context.status, closed.activity.actors[0].state], ["completed", "running"])
    const control = f.control(), mission = (await control.create({ requestID: "graceful", objective: "Graceful", template: "custom" })).mission
    const paused = (await control.lifecycle({ missionID: mission.id, expectedRevision: mission.revision, action: "pause", graceful: true, requestID: "pause" })).mission
    f.active.add(paused.coordinatorSessionId)
    const live = (await f.whole({ source: "activity", missionID: paused.id })).value
    assert.deepEqual([live.context.runState, live.context.control.action, live.context.control.graceful, live.activity.actors[0].state], ["paused", "pause", true, "running"])
    const interrupted = (await control.lifecycle({ missionID: paused.id, expectedRevision: paused.revision, action: "pause", requestID: "interrupt-now" })).mission
    const immediate = (await f.whole({ source: "activity", missionID: interrupted.id })).value
    assert.deepEqual([immediate.context.control.requestID, immediate.context.control.graceful, immediate.context.control.receipts,
      immediate.context.control.partialDescendants], ["interrupt-now", undefined, 1, 1], "a receipt with no descendant proof stays partial")
    // A readable older receipt without native acknowledgement is explicitly unconfirmed.
    for (const [key, value] of f.values) if ((value as any)?.missionID === interrupted.id && (value as any)?.type === "mission.control-applied") {
      const { nativeAcknowledgement: _ack, ...unknown } = value as Record<string, MissionJsonValue>
      f.values.set(key, unknown)
    }
    const unconfirmed = (await f.whole({ source: "activity", missionID: interrupted.id })).value
    assert.equal(unconfirmed.context.control.unconfirmedReceipts, 1)
    f.values.set(`codenomad-missions/v2/${f.journal.projectToken}/${paused.id}/evt_bad`, {})
    const damage = await f.read({ source: "activity", missionID: paused.id })
    assert.ok(damage.available)
    assert.deepEqual([damage.discardedEvents, damage.controlUnavailable, damage.notificationUnavailable, damage.cleanupUnavailable], [1, true, true, true])
    assert.equal(JSON.parse(damage.page.pieces[0].text).coverage, "unknown")
  } finally { await f.close() }
})
