import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_ROW_TITLE_MAX, missionClockTime, missionDisplayTitle, missionRelativeTime, missionScheduleWhen, missionShortTitle, missionZoneDiffers,
  missionZoneName } from "./mission-display"

test("an explicit title wins over the objective", () => {
  assert.equal(missionDisplayTitle({ title: "  Release  notes ", objective: "Write the notes." }), "Release notes")
  assert.equal(missionDisplayTitle({ title: " ", objective: "Write the notes. Then publish." }), "Write the notes")
})

test("row titles keep the whole first sentence for CSS truncation", () => {
  const sentence = "Audit every mission panel control, then align the toolbar icons with the session row geometry"
  assert.equal(missionDisplayTitle({ objective: `${sentence}. Then report.` }, MISSION_ROW_TITLE_MAX), sentence)
  assert.ok(missionDisplayTitle({ objective: sentence }).endsWith("…"))
})

test("short titles keep the first sentence and cut long text at a clause or word", () => {
  assert.equal(missionShortTitle("Fix the v1.2 parser. Then add tests."), "Fix the v1.2 parser")
  assert.equal(missionShortTitle("Audit login\nand everything else"), "Audit login")
  const clause = missionShortTitle("Migrate the persistence layer to the new storage engine, then remove the legacy adapters and tests")
  assert.equal(clause, "Migrate the persistence layer to the new storage engine…")
  const words = missionShortTitle("word ".repeat(30))
  assert.ok(Array.from(words).length <= 60 && words.endsWith("…") && !words.includes(" …"))
})

test("relative times and schedule days are localized", () => {
  const now = Date.UTC(2026, 9, 9, 12)
  assert.equal(missionRelativeTime(now - 2 * 3_600_000, "en", now), "2 hours ago")
  assert.equal(missionRelativeTime(now - 10_000, "en", now), "now")
  assert.deepEqual(missionScheduleWhen(Date.UTC(2026, 9, 10, 8, 15), "UTC", "en", now), { day: "tomorrow", time: "8:15 AM" })
  assert.equal(missionScheduleWhen(Date.UTC(2026, 9, 9, 18), "UTC", "en", now).day, "today")
  assert.equal(missionScheduleWhen(Date.UTC(2026, 9, 12, 8), "Not/AZone", "en", now).day.length > 0, true)
})

test("schedule clocks share the time format and label only a foreign zone", () => {
  assert.equal(missionClockTime("08:15", "en"), "8:15 AM")
  assert.equal(missionClockTime("08:15", "fr"), "08:15")
  assert.equal(missionClockTime("bad", "en"), "bad")
  assert.equal(missionZoneDiffers("UTC", "UTC"), false)
  assert.equal(missionZoneDiffers("Etc/UTC", "UTC"), false, "equal rules need no label")
  assert.equal(missionZoneDiffers("UTC", "Europe/Paris"), true)
  assert.equal(missionZoneDiffers("Not/AZone", "UTC"), true)
  assert.equal(missionZoneName("UTC", "en"), "UTC")
})
