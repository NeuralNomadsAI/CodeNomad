import assert from "node:assert/strict"
import test from "node:test"
import { nextMissionCalendarCron, previewMissionCalendar, previewMissionCalendars } from "./mission-calendar-plan"

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
