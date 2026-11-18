import assert from "node:assert/strict"
import test from "node:test"
import { currentPassageFixture } from "./native-current-passage-test-fixture"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { Effect } from "effect"

for (const owner of ["daily", "scheduled"] as const) test(`${owner} native current pages retain immutable passage, creation, configuration and Location proofs`, async () => {
  const f = await currentPassageFixture(owner)
  try {
    const beforeEffects = f.counts(), identity = await f.read(), source = identity.source!
    assert.equal(source.owner, owner); assert.equal(source.missionID, f.passage.missionID)
    assert.equal(f.metrics().ranges, 0)
    const selector = { source: "mission", missionID: source.missionID, header: true }
    const header = await f.page({ source, selector })
    assert.ok(header.available); assert.equal(f.metrics().ranges, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(header)) <= 65536)
    for (const field of ["projectID", "scheduleID", "passageID", "missionID", "digest", ...(owner === "scheduled" ? ["configurationGeneration", "timeGeneration"] : [])]) {
      const value = field.endsWith("Generation") ? 99 : field === "digest" ? "z".repeat(43) : "foreign"
      const ranges = f.metrics().ranges
      await assert.rejects(f.page({ source: { ...source, [field]: value }, selector }), /changed|differs|unavailable|not been admitted/)
      assert.equal(f.metrics().ranges, ranges, "foreign source is rejected before any range observation")
    }
    const location = f.ctx.location
    Object.assign(f.ctx, { location: { ...location, directory: f.root + "/foreign" } })
    await assert.rejects(f.page({ source, selector }), /Location changed/)
    Object.assign(f.ctx, { location })
    const actual = await f.storage.scan({ prefix: "codenomad-missions/", limit: 100 })
    let created = actual.entries.find(entry => (entry.value as { type?: string })?.type === "mission.created" && entry.key.includes(source.passageID))
    // Physical passage storage has its own prefix, selected from this exact execution.
    if (!created) {
      const prefix = owner === "daily" ? "codenomad-missions/recurrence" : "codenomad-missions/documents-v1"
      const page = await f.storage.scan({ prefix, limit: 100 })
      created = page.entries.find(entry => (entry.value as { type?: string })?.type === "mission.created" && entry.key.includes(source.passageID))
    }
    assert.ok(created, "real creation evidence is present")
    await f.storage.set(created.key, { ...(created.value as object), requestID: "foreign-creation" } as never)
    await assert.rejects(f.page({ source, selector }), /creation differs|journal unavailable/)
    await f.storage.set(created.key, created.value)
    await f.storage.set(created.key, { ...(created.value as object), projectCanonical: f.root + "/foreign" } as never)
    await assert.rejects(f.page({ source, selector }), /identity differs/)
    await f.storage.set(created.key, created.value)
    if (owner === "daily") {
      const doc = (await f.calendar.read(f.scheduleID))!
      await assert.rejects(f.calendar.configure(doc.id, doc.revision, { ...doc.config, consigne: doc.config.consigne + " changed" }, () => true), /pending/)
      await f.calendar.setState(doc.id, doc.revision, "paused", () => true)
    } else {
      const doc = await f.documents.read(f.scheduleID)
      assert.ok(doc && "configuration" in doc)
      await f.documents.change(doc.id, doc.revision, () => true, value => changes.configure(value, { ...value.configuration, notes: "New future instructions" }, 110))
    }
    assert.ok((await f.page({ source, selector })).available, "owner revision alone does not replace an immutable execution source")
    const fresh = await f.read()
    assert.equal(fresh.source!.missionID, source.missionID)
    assert.equal(fresh.source!.digest, source.digest)
    assert.notEqual(fresh.ownerRevision, identity.ownerRevision)
    assert.deepEqual(f.counts(), beforeEffects, "reads send no control, original input, environment or native creation")
  } finally { await f.dispose() }
})

for (const owner of ["daily", "scheduled"] as const) test(`${owner} old current continuations cannot cross to the next passage`, async () => {
  const f = await currentPassageFixture(owner)
  try {
    const source = (await f.read()).source!
    const first = await f.page({ source, selector: { source: "mission", missionID: source.missionID, header: true } })
    assert.ok(first.available)
    if (owner === "daily") {
      const doc = (await f.calendar.read(f.scheduleID))!
      const settled = await f.calendar.finish(doc.id, { passageID: f.passage.passageID, messageID: f.passage.messageID, missionID: f.passage.missionID,
        conversationID: f.passage.coordinatorSessionID, outcome: "completed", artifactMessageIDs: [], cursors: [] }, 130, () => true, doc.revision)
      await f.calendar.reserve(doc.id, settled.revision, { kind: "manual", requestID: "next", expectedRevision: settled.revision, at: 140 }, 140, () => true)
    } else {
      const doc = await f.documents.read(f.scheduleID); assert.ok(doc && "configuration" in doc)
      await f.documents.change(doc.id, doc.revision, () => true, value => {
        changes.settle(value, source.passageID, "completed", 130)
        changes.configure(value, { ...value.configuration, launch: { ...value.configuration.launch, timing: { kind: "every", intervalMs: 1800000 } } }, 135)
        changes.synchronized(value, `edit_${doc.revision + 1}`, (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: value.timeGeneration,
          scheduleID: `sch_next_${role}`, sessionID: `ses_next_${role}`, highWater: 0, pendingWake: null, wakePreparing: null })))
        changes.reserve(value, { kind: "manual", requestID: "next" }, 140, [])
      })
    }
    const next = (await f.read()).source!
    assert.notEqual(next.passageID, source.passageID); assert.notEqual(next.missionID, source.missionID)
    const ranges = f.metrics().ranges
    await assert.rejects(f.page({ source, selector: { source: "tasks", task: { missionID: source.missionID, offset: 0 } } }), /passage changed/)
    await assert.rejects(f.page({ source, selector: { source: "mission", missionID: source.missionID, field: "body", window: { offset: 0 } },
      body: { missionID: source.missionID, kind: "mission", field: "objective", offset: 0 } }), /passage changed/)
    assert.equal(f.metrics().ranges, ranges)
  } finally { await f.dispose() }
})

for (const owner of ["daily", "scheduled"] as const) test(`${owner} current cancellation joins the exact native range runtime before releasing its graph`, async () => {
  const f = await currentPassageFixture(owner), controller = new AbortController()
  let entered!: () => void, cleanup!: () => void, aborted = false, settled = false
  const started = new Promise<void>(resolve => { entered = resolve }), finalizer = new Promise<void>(resolve => { cleanup = resolve })
  const scan = f.ctx.storage.scan
  try {
    const source = (await f.read()).source!
    Object.assign(f.ctx.storage, { scan: () => Effect.callback((_resume, signal) => {
      entered(); signal.addEventListener("abort", () => { aborted = true }, { once: true })
      return Effect.promise(() => finalizer)
    }) })
    const running = f.page({ source, selector: { source: "mission", missionID: source.missionID, header: true } }, controller.signal)
    void running.then(() => { settled = true }, () => { settled = true })
    await started; controller.abort()
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()
    assert.equal(aborted, true, "the original RPC interruption reaches the actual storage runtime")
    assert.equal(settled, false, "the source graph remains retained during native cleanup")
    cleanup(); await assert.rejects(running)
  } finally { cleanup(); Object.assign(f.ctx.storage, { scan }); await f.dispose() }
})

for (const owner of ["daily", "scheduled"] as const) test(`${owner} current pages reject unreadable and foreign sibling range evidence`, async () => {
  const f = await currentPassageFixture(owner), scan = f.ctx.storage.scan
  try {
    const source = (await f.read()).source!, selector = { source: "mission", missionID: source.missionID, header: true }
    Object.assign(f.ctx.storage, { scan: () => Effect.fail(new Error("Unreadable current range")) })
    await assert.rejects(f.page({ source, selector }), /Unreadable current range/)
    Object.assign(f.ctx.storage, { scan: (input: Parameters<typeof scan>[0]) => scan(input).pipe(Effect.map(page => ({ ...page,
      entries: [...page.entries, { key: `${input.prefix}msn_foreign/evt_foreign`, value: {} }], complete: true }))) })
    await assert.rejects(f.page({ source, selector }), /unavailable|scope|entry|range|invalid/i)
  } finally { Object.assign(f.ctx.storage, { scan }); await f.dispose() }
})
