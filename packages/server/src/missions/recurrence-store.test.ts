import assert from "node:assert/strict"
import test from "node:test"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { canonicalAuthority } from "./authority-protocol"
import { RECURRENCE_HISTORY_LIMIT, RECURRENCE_MAX_BYTES, RECURRENCE_STORAGE_PREFIX,
  type RecurrenceAdmission, type RecurrenceConfig, type RecurrenceDocument, type RecurrenceResult } from "./recurrence-contract"
import { MissionRecurrenceRunner, type RecurrenceAuthorizedAdmission } from "./recurrence-runner"
import { NativeMissionRecurrenceStore } from "./recurrence-store"
import { latestDailyDue } from "./recurrence-clock"
import { missionProfileRoles } from "./playbook-profiles"

const current = () => true as const
function config(): RecurrenceConfig {
  const execution = { agent: "worker", model: { providerID: "provider", id: "model", variant: "default" } }
  return { title: "Review", template: "custom", consigne: "Review the explicitly watched conversations.",
    clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
    profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory: "/owned/project" }], watchedConversationIDs: ["ses_watched"] }
}
function accepted(doc: RecurrenceDocument): RecurrenceAdmission {
  return { kind: "accepted", passageID: doc.pending!.passage.id, messageID: doc.pending!.passage.messageID,
    missionID: `msn_${doc.pending!.passage.id}`, conversationID: "ses_passage" }
}
function terminal(doc: RecurrenceDocument): RecurrenceResult {
  const ack = doc.pending!.admission!
  return { passageID: ack.passageID, messageID: ack.messageID, missionID: ack.missionID, conversationID: ack.conversationID,
    outcome: "completed", artifactMessageIDs: ["msg_artifact"], cursors: [{ conversationID: "ses_watched", messageID: ack.messageID }] }
}
async function fixture(running = true) {
  const values = new Map<string, MissionJsonValue>()
  values.set("codenomad-missions/v2/legacy", { untouched: true })
  let now = Date.parse("2026-10-01T06:00:00Z"), writes = 0, callbacks = 0
  const scans: { prefix: string; after?: string; limit?: number }[] = []
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); writes++; values.set(key, structuredClone(value)) },
    scan: async options => {
      scans.push(options)
      const all = [...values].filter(([key]) => key.startsWith(options.prefix) && (!options.after || key > options.after))
        .sort(([left], [right]) => left < right ? -1 : 1)
      const entries = all.slice(0, options.limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(entries.length < all.length ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const store = new NativeMissionRecurrenceStore(storage, "project", "/owned/project")
  let doc = await store.create("daily_review", config(), now, current)
  if (running) doc = await store.setState(doc.id, doc.revision, "running", current)
  now = Date.parse("2026-10-01T07:05:00Z")
  const admission: RecurrenceAuthorizedAdmission = {
    authorize: async () => current,
    admit: async (document, beforeEffect) => { const fence = await beforeEffect(); fence(); callbacks++; return accepted(document) },
  }
  const runner = () => new MissionRecurrenceRunner(new NativeMissionRecurrenceStore(storage, "project", "/owned/project"), admission, () => now)
  const key = `${RECURRENCE_STORAGE_PREFIX}/project/${store.projectToken}/daily_review`
  return { values, storage, store, admission, runner, key, scans, get now() { return now },
    set now(value: number) { now = value }, counts: () => ({ writes, callbacks }) }
}

test("paused opt-in, missing and stopped schedules make zero admission callbacks; duplicate incarnations reserve once", async () => {
  const f = await fixture(false)
  assert.equal(await f.runner().tick("daily_review"), "inactive")
  assert.equal(await f.runner().tick("missing"), "inactive")
  assert.equal(f.counts().callbacks, 0)
  let doc = (await f.store.read("daily_review"))!
  await f.store.setState(doc.id, doc.revision, "running", current)
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => f.runner().tick("daily_review")))
  assert.equal(outcomes.filter(outcome => outcome === "accepted").length, 1)
  assert.equal(f.counts().callbacks, 1)
  doc = (await f.store.read("daily_review"))!
  assert.deepEqual(doc.pending!.admission, accepted(doc))
  assert.equal(await f.runner().trigger(doc.id, doc.revision, "manual_request"), "pending")
  assert.deepEqual(f.values.get("codenomad-missions/v2/legacy"), { untouched: true })
})

test("recurrence preserves exact agent/model selections without inventing a variant for models that have none", async () => {
  const f = await fixture(false), selection = config()
  delete selection.profiles!.coordinator!.model!.variant
  delete selection.profiles!.roles!.specialist!.model!.variant
  let doc = await f.store.create("no_variant", selection, f.now, current)
  assert.equal(doc.config.profiles!.coordinator!.model!.variant, undefined)
  doc = await f.store.setState(doc.id, doc.revision, "running", current)
  f.now += 86_400_000
  assert.equal(await f.runner().tick(doc.id), "accepted")
  assert.equal((await f.store.read(doc.id))!.config.profiles!.roles!.specialist!.model!.variant, undefined)
})

test("removing and readding watched conversations preserves their cursors without granting removed targets new reads", async () => {
  const f = await fixture()
  assert.equal(await f.runner().tick("daily_review"), "accepted")
  let doc = (await f.store.read("daily_review"))!
  doc = await f.store.finish(doc.id, terminal(doc), f.now, current)
  const original = structuredClone(doc.cursors)
  doc = await f.store.configure(doc.id, doc.revision, { ...config(), watchedConversationIDs: ["ses_replacement"] }, current)
  assert.deepEqual(doc.cursors, original)
  f.now += 86_400_000
  assert.equal(await f.runner().tick(doc.id), "accepted")
  doc = (await f.store.read(doc.id))!
  const before = canonicalAuthority(doc)
  await assert.rejects(f.store.finish(doc.id, terminal(doc), f.now, current), /result conflict/, "removed watch cannot advance its cursor")
  assert.equal(canonicalAuthority(await f.store.read(doc.id)), before)
  doc = await f.store.finish(doc.id, { ...terminal(doc), cursors: [{ conversationID: "ses_replacement", messageID: "msg_new" }] }, f.now, current)
  doc = await f.store.configure(doc.id, doc.revision, config(), current)
  assert.deepEqual(doc.cursors.find(cursor => cursor.conversationID === "ses_watched"), original[0])
  assert.equal(await f.runner().tick(doc.id), "not-due")
})

test("failed/stopped settlement never turns supplied read cursor claims into handled source work", async () => {
  const f = await fixture()
  assert.equal(await f.runner().tick("daily_review"), "accepted")
  let doc = (await f.store.read("daily_review"))!
  doc = await f.store.finish(doc.id, terminal(doc), f.now, current)
  const original = structuredClone(doc.cursors)
  for (const outcome of ["failed", "stopped"] as const) {
    f.now += 86_400_000
    assert.equal(await f.runner().tick(doc.id), "accepted")
    doc = (await f.store.read(doc.id))!
    doc = await f.store.finish(doc.id, { ...terminal(doc), outcome,
      cursors: [{ conversationID: "ses_watched", messageID: "msg_read_but_not_processed" }] }, f.now, current)
    assert.deepEqual(doc.cursors, original)
    const result = doc.history.at(-1)!.result
    assert.equal("outcome" in result && result.outcome, outcome)
    assert.equal(doc.pending, null, "a qualified terminal failure retires its passage without consuming sources")
  }
})

test("remembered watch capacity rejects new scopes before dispatch rather than losing deduplication", async () => {
  const f = await fixture(false), selection = config()
  selection.watchedConversationIDs = Array.from({ length: 32 }, (_, index) => `ses_original_${index}`)
  let doc = await f.store.create("cursor_capacity", selection, f.now, current)
  doc = await f.store.setState(doc.id, doc.revision, "running", current)
  for (const watched of [selection.watchedConversationIDs, Array.from({ length: 32 }, (_, index) => `ses_replacement_${index}`)]) {
    doc = await f.store.configure(doc.id, doc.revision, { ...selection, watchedConversationIDs: watched }, current)
    f.now += 86_400_000
    // Storage capacity is independent of the smaller native initial-input cap.
    doc = await f.store.reserve(doc.id, doc.revision, { kind: "daily", clock: doc.config.clock,
      ...latestDailyDue(doc.config.clock, f.now) }, f.now, current)
    doc = await f.store.recordAdmission(doc.id, accepted(doc), f.now, current)
    doc = await f.store.finish(doc.id, { ...terminal(doc), cursors: watched.map(conversationID => ({ conversationID, messageID: "msg_processed" })) }, f.now, current)
  }
  assert.equal(doc.cursors.length, 64)
  const before = canonicalAuthority(doc), counts = f.counts()
  await assert.rejects(f.store.configure(doc.id, doc.revision, { ...selection, watchedConversationIDs: ["ses_new"] }, current))
  assert.equal(canonicalAuthority(await f.store.read(doc.id)), before)
  assert.deepEqual(f.counts(), counts)
})

test("sleep catches up only latest day; restart and config CAS never reset original due/high-water", async () => {
  const f = await fixture()
  f.now = Date.parse("2026-10-20T08:00:00Z")
  assert.equal(await f.runner().tick("daily_review"), "accepted")
  let doc = (await f.store.read("daily_review"))!
  assert.equal(doc.pending!.passage.due.kind, "daily")
  assert.equal(doc.lastDaily, null, "daily high-water advances only with the archive")
  assert.equal(doc.pending!.passage.due.kind === "daily" && doc.pending!.passage.due.civilDay, "2026-10-20")
  const due = structuredClone(doc.pending!.passage.due), createdAt = doc.createdAt
  const dirtyDraftRevision = doc.revision
  doc = await f.store.finish(doc.id, terminal(doc), f.now, current)
  await assert.rejects(f.store.configure(doc.id, dirtyDraftRevision, { ...config(), consigne: "dirty draft" }, current), /revision conflict/)
  doc = await f.store.configure(doc.id, doc.revision, { ...config(), consigne: "New consigne", clock: { time: "08:00", zone: "UTC" } }, current)
  assert.equal(doc.createdAt, createdAt)
  assert.deepEqual(doc.lastDaily, due)
  assert.equal(await f.runner().tick(doc.id), "not-due", "editing clock cannot create a second passage this civil day")
  f.now = Date.parse("2026-10-21T08:01:00Z")
  assert.equal(await f.runner().tick(doc.id), "accepted")
  assert.equal((await f.store.read(doc.id))!.pending!.passage.scheduleRevision, 1)
  assert.equal(f.counts().callbacks, 2)
})

test("40 daily passages retain 30 reference receipts plus high-water/cursors, never grow the one-shot journal", async () => {
  const f = await fixture()
  for (let day = 0; day < 40; day++) {
    f.now = Date.parse("2026-10-01T08:00:00Z") + day * 86_400_000
    assert.equal(await f.runner().tick("daily_review"), "accepted")
    const doc = (await f.store.read("daily_review"))!
    await f.store.finish(doc.id, terminal(doc), f.now, current)
  }
  const doc = (await f.store.read("daily_review"))!
  assert.equal(doc.settledCount, 40)
  assert.equal(doc.history.length, RECURRENCE_HISTORY_LIMIT)
  assert.equal(doc.history[0].passage.due.kind === "daily" && doc.history[0].passage.due.civilDay, "2026-10-11")
  assert.equal(doc.lastDaily!.civilDay, "2026-11-09")
  assert.equal(doc.cursors.length, 1)
  assert.equal("cursors" in doc.history[0].result, false)
  assert.ok(Buffer.byteLength(canonicalAuthority(doc, RECURRENCE_MAX_BYTES)) < RECURRENCE_MAX_BYTES)
  assert.equal(f.values.size, 2)
  assert.equal(await f.runner().tick(doc.id), "not-due")
  f.now = Date.parse("2026-09-01T08:00:00Z")
  assert.equal(await f.runner().tick(doc.id), "not-due", "backward clock never resets the cursor")
})

test("reservation leaves space to settle maximum reference/cursor receipts throughout history rollover", async () => {
  const f = await fixture(false), heavy = config()
  heavy.consigne = "\0".repeat(7_000)
  heavy.roots = [0, 1].map(index => ({ mode: "directory-only", directory: `/${index}${"x".repeat(4_094)}` }))
  heavy.watchedConversationIDs = Array.from({ length: 32 }, (_, index) => `ses_${index}`.padEnd(240, "x"))
  let doc = await f.store.create("large_schedule", heavy, f.now, current)
  doc = await f.store.setState(doc.id, doc.revision, "running", current)
  const artifacts = Array.from({ length: 8 }, (_, index) => `msg_${index}`.padEnd(240, "x"))
  const cursors = heavy.watchedConversationIDs.map(conversationID => ({ conversationID, messageID: "m".repeat(240) }))
  for (let day = 0; day < 32; day++) {
    f.now += 86_400_000
    // Deliberately exercise maximum durable reference rows directly, not native
    // execution: this synthetic configuration exceeds the lifecycle text cap.
    doc = await f.store.reserve(doc.id, doc.revision, { kind: "daily", clock: doc.config.clock,
      ...latestDailyDue(doc.config.clock, f.now) }, f.now, current)
    doc = await f.store.recordAdmission(doc.id, { ...accepted(doc), missionID: "m".repeat(240), conversationID: "s".repeat(240) } as RecurrenceAdmission, f.now, current)
    doc = await f.store.finish(doc.id, { ...terminal(doc), artifactMessageIDs: artifacts, cursors }, f.now, current)
  }
  assert.equal(doc.settledCount, 32)
  assert.equal(doc.history.length, 30)
  assert.equal(doc.cursors.length, 32)
  assert.ok(Buffer.byteLength(canonicalAuthority(doc, RECURRENCE_MAX_BYTES)) < RECURRENCE_MAX_BYTES)
})

for (const failure of ["before-effect-throw", "after-effect-throw", "wrong-ack", "partial-rejection"] as const) {
  test(`${failure}: original pending survives restart, no TTL release/replay/config rebase`, async () => {
    const f = await fixture()
    let admissions = 0, effects = 0
    f.admission.admit = async doc => {
      admissions++
      if (failure === "before-effect-throw") throw new Error(failure)
      effects++
      if (failure === "after-effect-throw") throw new Error(failure)
      if (failure === "wrong-ack") return { ...accepted(doc), passageID: "foreign_passage" }
      return { kind: "rejected-before-effect", passageID: doc.pending!.passage.id,
        messageID: doc.pending!.passage.messageID, effect: "partial", proofID: "proof" } as unknown as RecurrenceAdmission
    }
    assert.equal(await f.runner().tick("daily_review"), "unknown")
    const pending = (await f.store.read("daily_review"))!, bytes = canonicalAuthority(pending)
    assert.equal(pending.pending!.admission, null)
    f.now += 400 * 86_400_000
    assert.equal(await f.runner().tick(pending.id), "pending")
    assert.equal(await f.runner().trigger(pending.id, pending.revision, "manual_request"), "pending")
    await assert.rejects(f.store.configure(pending.id, pending.revision, { ...config(), consigne: "Changed" }, current), /pending/)
    assert.equal(canonicalAuthority(await f.store.read(pending.id)), bytes)
    assert.equal(admissions, 1, "restart/elapsed time/manual trigger never reenter admission")
    assert.equal(effects, failure === "before-effect-throw" ? 0 : 1)
    const ack = accepted(pending)
    const reconciled = await f.store.recordAdmission(pending.id, ack, f.now, current)
    await f.store.finish(pending.id, terminal(reconciled), f.now, current)
    assert.equal(await f.runner().tick(pending.id), "unknown", "only a NEW latest due may be attempted after exact reconciliation")
    assert.equal(admissions, 2)
  })
}

test("ended-without-report is a terminal reference, not a pre-effect rejection proof", async () => {
  const f = await fixture()
  assert.equal(await f.runner().tick("daily_review"), "accepted")
  const doc = (await f.store.read("daily_review"))!
  await f.store.finish(doc.id, { ...terminal(doc), outcome: "ended-without-report" }, f.now, current)
  assert.equal((await f.store.read("daily_review"))!.pending, null)
  assert.equal(await f.runner().tick("daily_review"), "not-due")
  assert.equal((await f.store.read("daily_review"))!.history.at(-1)!.result.outcome, "ended-without-report")
})

test("Pause/Stop block triggers but preserve results; terminal Stop cannot resume", async () => {
  for (const state of ["paused", "stopped"] as const) {
    const f = await fixture(), purposes: string[] = []
    f.admission.authorize = async (_doc, purpose) => { purposes.push(purpose); return current }
    f.admission.admit = async (doc, beforeEffect) => {
      const fence = await beforeEffect(); fence()
      // Native admission has happened; a later Pause/Stop must not lose its ACK.
      await f.store.setState(doc.id, doc.revision, state, current)
      return accepted(doc)
    }
    assert.equal(await f.runner().tick("daily_review"), "accepted")
    let doc = (await f.store.read("daily_review"))!
    assert.equal(doc.state, state)
    assert.equal(purposes.at(-1), "settle")
    doc = await f.store.finish(doc.id, { ...terminal(doc), outcome: "failed" }, f.now, current)
    assert.equal("outcome" in doc.history[0].result && doc.history[0].result.outcome, "failed")
    f.now += 86_400_000
    assert.equal(await f.runner().tick(doc.id), "inactive")
    if (state === "stopped") {
      assert.equal(await f.runner().trigger(doc.id, doc.revision, "manual_request"), "inactive")
      await assert.rejects(f.store.setState(doc.id, doc.revision, "running", current), /terminal/)
    }
  }
})

test("read-only/unowned/disabled authority and invalid target make zero callbacks or writes", async () => {
  for (const reason of ["read-only", "unowned", "disabled"]) {
    const f = await fixture(), counts = f.counts()
    f.admission.authorize = async () => { throw new Error(reason) }
    await assert.rejects(f.runner().tick("daily_review"), new RegExp(reason))
    await assert.rejects(f.runner().tick("../foreign"))
    assert.deepEqual(f.counts(), counts)
    assert.equal((await f.store.read("daily_review"))!.pending, null)
  }
})

test("recurrence authority approval must be synchronous literal true before reservation or settlement", async () => {
  const denied = [() => false, () => undefined, async () => { throw new Error("owner retired") },
    () => ({ then() { assert.fail("authority must not assimilate a thenable") } })]
  for (const check of denied) {
    const f = await fixture(), counts = f.counts(), before = canonicalAuthority(await f.store.read("daily_review"))
    const unsafe = check as unknown as () => true
    f.admission.authorize = async () => unsafe
    await assert.rejects(f.runner().tick("daily_review"), /policy-unqualified/)
    await assert.rejects(f.store.setState("daily_review", 1, "paused", unsafe), /policy-unqualified/)
    assert.deepEqual(f.counts(), counts)
    assert.equal(canonicalAuthority(await f.store.read("daily_review")), before)

    f.admission.authorize = async (_doc, purpose) => purpose === "settle" ? unsafe : current
    assert.equal(await f.runner().tick("daily_review"), "unknown")
    const pending = (await f.store.read("daily_review"))!
    assert.equal(pending.pending!.admission, null, "an invalid settlement fence cannot acknowledge a reserved effect")
    assert.equal(f.counts().callbacks, 1)
    assert.equal(await f.runner().tick("daily_review"), "pending", "uncertain effects remain reserved without replay")
  }
})

test("native storage preparation rechecks literal approval rather than passing through an async guard", async () => {
  const f = await fixture(), before = structuredClone([...f.values]), counts = f.counts()
  let checks = 0
  const current = (() => ++checks === 1 ? true : Promise.reject(new Error("owner retired during preparation"))) as unknown as () => true
  await assert.rejects(f.store.setState("daily_review", 1, "paused", current), /policy-unqualified/)
  assert.equal(checks, 2)
  assert.deepEqual([...f.values], before)
  assert.deepEqual(f.counts(), counts)
})

test("beforeEffect returns a guarded final callback when ownership changes after preparation", async () => {
  for (const denial of [false, undefined]) {
    const f = await fixture()
    let nativeEntry = false, effects = 0
    f.admission.authorize = async () => (() => nativeEntry ? denial : true) as () => true
    f.admission.admit = async (doc, beforeEffect) => {
      const fence = await beforeEffect()
      nativeEntry = true
      fence()
      effects++
      return accepted(doc)
    }
    assert.equal(await f.runner().tick("daily_review"), "unknown")
    assert.equal(effects, 0)
    const doc = (await f.store.read("daily_review"))!
    assert.equal(doc.pending!.admission, null)
    assert.equal(await f.runner().tick(doc.id), "pending")
  }
})

test("async preparation fences revoke authority/Pause; uncertain storage publication never admits", async () => {
  for (const mode of ["before-write", "after-write", "revoked", "paused-during-authorize"]) {
    const f = await fixture(), nativeSet = f.storage.set
    if (mode === "before-write" || mode === "after-write") {
      f.storage.set = async (key, value, fence) => {
        if (mode === "after-write") await nativeSet(key, value, fence)
        throw new Error("storage ACK lost")
      }
    } else if (mode === "revoked") {
      let active = true
      f.admission.authorize = async () => () => { if (!active) throw new Error("revoked"); return true }
      f.storage.set = async (key, value, fence) => { active = false; await nativeSet(key, value, fence) }
    } else {
      let reads = 0
      f.admission.authorize = async doc => {
        if (++reads === 2) await f.store.setState(doc.id, doc.revision, "paused", current)
        return current
      }
    }
    if (mode === "paused-during-authorize") assert.equal(await f.runner().tick("daily_review"), "unknown")
    else await assert.rejects(f.runner().tick("daily_review"))
    assert.equal(f.counts().callbacks, 0)
    if (mode === "after-write") {
      f.storage.set = nativeSet
      assert.equal(await f.runner().tick("daily_review"), "pending")
    }
  }
})

test("manual passage is explicit CAS, stable IDs, single-flight; frozen template/profile/taskMode cannot be changed", async () => {
  const f = await fixture(false), doc = (await f.store.read("daily_review"))!
  assert.equal(await f.runner().trigger(doc.id, doc.revision, "manual_request"), "accepted")
  let pending = (await f.store.read(doc.id))!
  assert.equal(pending.pending!.passage.due.kind, "manual")
  pending = await f.store.finish(doc.id, terminal(pending), f.now, current)
  await assert.rejects(f.runner().trigger(doc.id, doc.revision, "manual_request"), /revision conflict/)
  await assert.rejects(f.store.configure(doc.id, pending.revision, { ...config(), taskMode: "independent" }, current), /immutable/)
  await assert.rejects(f.store.configure(doc.id, pending.revision, { ...config(), profileID: "different" }, current), /immutable/)
  const changed = config(); changed.profiles!.coordinator!.model!.variant = "other"
  await assert.rejects(f.store.configure(doc.id, pending.revision, changed, current), /immutable/)
  const wayfinder = config(); wayfinder.template = "wayfinder"
  wayfinder.profiles!.roles = Object.fromEntries(missionProfileRoles.wayfinder.map(role => [role, wayfinder.profiles!.coordinator!]))
  await assert.rejects(f.store.configure(doc.id, pending.revision, wayfinder, current), /immutable/)
})

test("created after today's clock waits for a new day; Pause at actual admission leaves pending without effect", async () => {
  const f = await fixture(false)
  let doc = await f.store.create("late_schedule", config(), f.now, current)
  doc = await f.store.setState(doc.id, doc.revision, "running", current)
  assert.equal(await f.runner().tick(doc.id), "not-due")
  f.now += 86_400_000
  let effects = 0
  f.admission.admit = async (reserved, beforeEffect) => {
    await f.store.setState(reserved.id, reserved.revision, "paused", current)
    const fence = await beforeEffect(); fence()
    effects++
    return accepted(reserved)
  }
  assert.equal(await f.runner().tick(doc.id), "unknown")
  assert.equal(effects, 0)
  doc = (await f.store.read(doc.id))!
  assert.equal(doc.state, "paused")
  assert.equal(doc.pending!.admission, null)
})

test("result publication ACK loss keeps original passage and never causes admission replay", async () => {
  const f = await fixture(), nativeSet = f.storage.set
  f.storage.set = async (key, value, fence) => {
    await nativeSet(key, value, fence)
    if ((value as unknown as RecurrenceDocument).pending?.admission) throw new Error("admission receipt ACK lost")
  }
  assert.equal(await f.runner().tick("daily_review"), "unknown")
  assert.equal(f.counts().callbacks, 1)
  f.storage.set = nativeSet
  assert.equal(await f.runner().tick("daily_review"), "pending")
  const doc = (await f.store.read("daily_review"))!
  assert.ok(doc.pending!.admission, "the durable ACK is reconciled by observation, not replay")
  await assert.rejects(f.store.finish(doc.id, { ...terminal(doc), missionID: "msn_foreign" }, f.now, current), /result conflict/)
  await f.store.finish(doc.id, terminal(doc), f.now, current)
  assert.equal(await f.runner().tick(doc.id), "not-due")
  assert.equal(f.counts().callbacks, 1)
})

test("strict bounded codec leaves damaged/foreign stored bytes unchanged and never calls admission", async () => {
  for (const damage of ["foreign-project", "foreign-passage", "extra-field", "overflow", "cursor-source", "bad-high-water"]) {
    const f = await fixture()
    await f.runner().tick("daily_review")
    const value = structuredClone(f.values.get(f.key)) as any
    if (damage === "foreign-project") value.projectCanonical = "/foreign"
    if (damage === "foreign-passage") value.pending.passage.messageID = "msg_foreign"
    if (damage === "extra-field") value.unrecognized = true
    if (damage === "overflow") value.config.consigne = "x".repeat(20_001)
    if (damage === "cursor-source") value.cursors = [{ conversationID: "ses_foreign", messageID: "msg_owned" }]
    if (damage === "bad-high-water") value.lastDaily = { ...value.pending.passage.due, at: value.pending.passage.due.at + 1 }
    f.values.set(f.key, value)
    const bytes = JSON.stringify(value), counts = f.counts()
    for (const operation of [() => f.store.read("daily_review"), () => f.store.list(), () => f.runner().tick("daily_review"),
      () => f.store.setState("daily_review", value.revision, "paused", current)]) await assert.rejects(operation())
    assert.equal(JSON.stringify(f.values.get(f.key)), bytes)
    assert.deepEqual(f.counts(), counts)
  }
})

test("native scan pages/capacity/cursors/foreign placement bounded; failed creates never alter bytes", async () => {
  const f = await fixture(false)
  for (let index = 1; index < 64; index++) await f.store.create(`schedule_${String(index).padStart(3, "0")}`, config(), f.now, current)
  assert.equal((await f.store.list()).length, 64)
  assert.ok(f.scans.every(scan => scan.limit === 16 && scan.prefix.startsWith(RECURRENCE_STORAGE_PREFIX)))
  const bytes = JSON.stringify([...f.values])
  await assert.rejects(f.store.create("overflow", config(), f.now, current), /capacity/)
  await assert.rejects(f.store.create("../traversal", config(), f.now, current))
  const big = config(); big.consigne = "\0".repeat(20_000)
  await assert.rejects(f.store.create("oversized", big, f.now, current))
  assert.equal(JSON.stringify([...f.values]), bytes)
  const nativeScan = f.storage.scan
  for (const malformed of ["wrong-next", "empty-next", "foreign-key", "oversized-page"]) {
    f.storage.scan = async options => {
      const page = await nativeScan(options)
      if (malformed === "wrong-next") return { ...page, next: "../foreign" }
      if (malformed === "empty-next") return { entries: [], next: options.prefix }
      if (malformed === "foreign-key") return { entries: [{ key: "foreign/key", value: page.entries[0].value }] }
      return { entries: Array(17).fill(page.entries[0]) }
    }
    await assert.rejects(f.store.list())
    await assert.rejects(f.store.create("foreign_test", config(), f.now, current))
    assert.equal(JSON.stringify([...f.values]), bytes)
  }
})
