import assert from "node:assert/strict"
import test from "node:test"
import { dailyClockSchema, dailyOccurrence, latestDailyDue } from "./recurrence-clock"

test("daily civil clock: gaps advance, folds fire once, non-hour zones and skipped days", () => {
  const occurrence = (zone: string, time: string, day: string) => dailyOccurrence({ zone, time }, day)?.at
  assert.equal(occurrence("America/New_York", "02:30", "2026-03-08"), Date.parse("2026-03-08T07:00:00Z"))
  assert.equal(occurrence("America/New_York", "01:30", "2026-11-01"), Date.parse("2026-11-01T05:30:00Z"))
  assert.equal(latestDailyDue({ zone: "America/New_York", time: "01:30" }, Date.parse("2026-11-01T06:45:00Z")).at,
    Date.parse("2026-11-01T05:30:00Z"), "second fold must retain the original due identity")
  assert.equal(occurrence("Australia/Lord_Howe", "02:15", "2026-10-04"), Date.parse("2026-10-03T15:30:00Z"))
  assert.equal(occurrence("Asia/Kathmandu", "07:00", "2026-10-07"), Date.parse("2026-10-07T01:15:00Z"))
  assert.equal(occurrence("America/Nuuk", "23:30", "2026-03-28"), Date.parse("2026-03-29T01:00:00Z"), "end-of-day gap advances to next civil midnight")
  assert.deepEqual(latestDailyDue({ zone: "America/Nuuk", time: "23:30" }, Date.parse("2026-03-29T02:00:00Z")),
    { civilDay: "2026-03-28", at: Date.parse("2026-03-29T01:00:00Z") })
  assert.equal(occurrence("Pacific/Apia", "07:00", "2011-12-30"), undefined)
  assert.deepEqual(latestDailyDue({ zone: "Pacific/Apia", time: "07:00" }, Date.parse("2011-12-30T12:00:00Z")),
    { civilDay: "2011-12-29", at: Date.parse("2011-12-29T17:00:00Z") })
})

test("latest catchup is one day, deterministic independent of host TZ; invalid dates/zones fail", () => {
  const previous = process.env.TZ
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = zone
      assert.deepEqual(latestDailyDue({ zone: "Europe/Paris", time: "07:00" }, Date.parse("2026-10-07T04:59:00Z")),
        { civilDay: "2026-10-06", at: Date.parse("2026-10-06T05:00:00Z") })
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
  for (const clock of [{ time: "24:00", zone: "UTC" }, { time: "7:00", zone: "UTC" },
    { time: "07:00", zone: "No/Such_Zone" }, { time: "07:00", zone: "+02:00" }]) assert.equal(dailyClockSchema.safeParse(clock).success, false)
  assert.throws(() => dailyOccurrence({ zone: "UTC", time: "07:00" }, "2026-02-30"))
  assert.throws(() => latestDailyDue({ zone: "UTC", time: "07:00" }, NaN))
})
