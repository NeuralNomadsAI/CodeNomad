import assert from "node:assert/strict"
import test from "node:test"
import { missionCalendarPlans, nextMissionCalendarCron, previewMissionCalendar, previewMissionCalendars } from "./mission-calendar-plan"
import { NativeMissionDocumentStore } from "./mission-document-store"
import { ownerFixture } from "../opencode/missions/native-schedule-owner-test-fixture"
import { missionDocumentChanges } from "./mission-document-state"
import { parseMissionDocument } from "./mission-document"

test("policy projects all native timings, an absolute common end, every:15-min event-only and eight independent cron slots", async t => {
  const f = await ownerFixture(t)
  const root = await f.read()
  const scenarios = [
    { timing: { kind: "at" as const, at: f.now + 100_000, zone: "UTC" }, type: "at" },
    { timing: { kind: "in" as const, delayMs: 100_000 }, type: "in" },
    { timing: { kind: "every" as const, intervalMs: 15 * 60_000 }, type: "every" },
    { timing: { kind: "cron" as const, expression: "15 9 * * *", zone: "Europe/Paris" }, type: "cron" },
  ]
  for (const scenario of scenarios) {
    const doc = structuredClone(root)
    doc.configuration.launch = { timing: scenario.timing, condition: null, ends: { maxLaunches: 3, afterMs: 3 * 86_400_000, at: null } }
    missionDocumentChanges.play(doc, "first_play", f.now, [])
    const plans = missionCalendarPlans(doc, f.now)
    assert.equal(plans[0].role, "reconciliation"); assert.equal(plans[0].endsAt, null)
    assert.equal(plans[1].when.type, scenario.type); assert.equal(plans[1].endsAt, f.now + 3 * 86_400_000)
    assert(!("times" in plans[1]))
  }
  const doc = structuredClone(root)
  doc.configuration.launch.timing = { kind: "multi", calendars: Array.from({ length: 8 }, (_, index) => ({ expression: `${index} ${index} * * *`, zone: "UTC" })) }
  missionDocumentChanges.play(doc, "multi", f.now, [])
  assert.equal(missionCalendarPlans(doc, f.now).length, 9)
  doc.configuration.launch.timing = { kind: "immediate" }
  doc.configuration.launch.condition = { kind: "files-changed", paths: ["selected.txt"] }
  const event = missionCalendarPlans(doc, f.now)[1]
  assert.deepEqual(event.when, { type: "every", every: "900000 millis", tz: "UTC" })
})

test("native cron wrapper matches DST gaps, repeated hour and merged bounded preview", () => {
  const zone = "America/New_York"
  assert.equal(nextMissionCalendarCron("30 2 * * *", zone, Date.parse("2026-03-08T06:59:00Z")), Date.parse("2026-03-08T07:30:00Z"))
  assert.equal(nextMissionCalendarCron("30 1 * * *", zone, Date.parse("2026-11-01T04:00:00Z")), Date.parse("2026-11-01T05:30:00Z"))
  assert.equal(nextMissionCalendarCron("30 1 * * *", zone, Date.parse("2026-11-01T05:40:00Z")), Date.parse("2026-11-02T06:30:00Z"))
  const plan = { role: "principal" as const, slot: 0, when: { type: "every" as const, every: "900000 millis", tz: "UTC" }, endsAt: 1_800_000, anchorAt: 0 }
  assert.deepEqual(previewMissionCalendar(plan, 0), [900_000, 1_800_000])
  const cron = (expression: string, slot: number) => ({ role: "principal" as const, slot, when: { type: "cron" as const, cron: expression, tz: "UTC" }, endsAt: null, anchorAt: 0 })
  const preview = previewMissionCalendars([cron("15 9 * * *", 0), cron("45 17 * * *", 1), cron("15 9 * * *", 2)], Date.parse("2026-10-30T00:00Z"))
  assert.deepEqual(preview.map(at => new Date(at).toISOString()), ["2026-10-30T09:15:00.000Z", "2026-10-30T17:45:00.000Z", "2026-10-31T09:15:00.000Z", "2026-10-31T17:45:00.000Z", "2026-11-01T09:15:00.000Z"])
})

test("scoped store serializes native I/O without reentrant deadlock, expires its view and preserves immutable creation", async t => {
  const f = await ownerFixture(t)
  let escaped!: NativeMissionDocumentStore
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const operation = f.store.withExclusion(async locked => {
    escaped = locked
    const current = await locked.read("calendar_test")
    assert(current && !("deletedAt" in current))
    await locked.change(current.id, current.revision, f.current, doc => { doc.configuration.notes = "same owned lock" })
    entered(); await gate
  })
  await started
  let outside = false
  const next = f.store.withExclusion(async () => { outside = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(outside, false)
  release(); await operation; await next
  await assert.rejects(escaped.read("calendar_test"), /exclusion ended/)
  const created = await f.store.withExclusion(locked => locked.create("second_document", f.configuration, f.now, f.current, null,
    { requestID: "original_creation", digest: "f".repeat(64) }))
  await assert.rejects(f.store.change(created.id, created.revision, f.current, doc => { doc.creation!.digest = "0".repeat(64) }), /monotone/)
  const raw = structuredClone(created) as any
  delete raw.calendarOwner; delete raw.fanIn; delete raw.creation
  const parsed = parseMissionDocument(raw, created)
  assert.equal(parsed.calendarOwner, null); assert.equal(parsed.fanIn, null); assert.equal(parsed.creation, undefined)
})

test("admission attempt defaults false and cannot be cleared or omitted for the same pending", async t => {
  const f = await ownerFixture(t), armed = await f.control("play")
  let doc = await f.store.change(armed.id, armed.revision, f.current,
    value => missionDocumentChanges.reserve(value, { kind: "manual", requestID: "first_admission" }, f.now, []))
  const raw = structuredClone(doc) as any
  delete raw.pending.admissionAttempted
  assert.equal(parseMissionDocument(raw, doc).pending!.admissionAttempted, false)
  doc = await f.store.change(doc.id, doc.revision, f.current, value => { value.pending!.admissionAttempted = true })
  await assert.rejects(f.store.change(doc.id, doc.revision, f.current, value => { value.pending!.admissionAttempted = false }), /monotone/)
  await assert.rejects(f.store.change(doc.id, doc.revision, f.current, value => { delete (value.pending as any).admissionAttempted }), /monotone/)
  const saved = await f.read()
  assert.equal(saved.pending!.admissionAttempted, true); assert.equal(saved.launchedCount, 0)
  assert.equal(saved.firstPlayedAt, armed.firstPlayedAt)
  assert.deepEqual(saved.pending!.configuration.profiles, armed.configuration.profiles)
})

test("manual expected revision is optional, counter-validated and exclusive to manual pending/history origins", async t => {
  const f = await ownerFixture(t), armed = await f.control("play")
  const doc = await f.store.change(armed.id, armed.revision, f.current,
    value => missionDocumentChanges.reserve(value, { kind: "manual", requestID: "manual_schema" }, f.now, []))
  assert.equal(doc.pending!.manualExpectedRevision, undefined)
  for (const revision of [-1, 0.5, "1"]) {
    const raw = structuredClone(doc) as any
    raw.pending.manualExpectedRevision = revision
    assert.throws(() => parseMissionDocument(raw, doc))
  }
  const raw = structuredClone(doc)
  raw.pending!.manualExpectedRevision = 0
  assert.equal(parseMissionDocument(raw, doc).pending!.manualExpectedRevision, 0)
  const other = await ownerFixture(t), ready = await other.control("play"), principal = ready.calendars.find(item => item.role === "principal")!
  await assert.rejects(other.store.change(ready.id, ready.revision, other.current, value => {
    const wake = { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: other.now }
    missionDocumentChanges.prepareWake(value, wake)
    missionDocumentChanges.reserve(value, { kind: "wake", wakes: [wake] }, other.now, [])
    value.pending!.manualExpectedRevision = ready.revision
  }), /Invalid Mission/)
})
