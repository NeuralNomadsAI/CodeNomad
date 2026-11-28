import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_ROW_TITLE_MAX, missionDisplayTitle, missionRelativeTime, missionShortTitle } from "./mission-display"
import { missionObjectiveLabel, missionSummary } from "../../../server/src/missions/mission-summary"

test("an explicit title wins over the objective", () => {
  assert.equal(missionDisplayTitle({ title: "  Release  notes ", objective: "Write the notes." }), "Release notes")
  assert.equal(missionDisplayTitle({ title: " ", objective: "Write the notes. Then publish." }), "Write the notes")
})

test("row titles keep the whole first sentence for CSS truncation", () => {
  const sentence = "Audit every mission panel control, then align the toolbar icons with the session row geometry"
  assert.equal(missionDisplayTitle({ objective: `${sentence}. Then report.` }, MISSION_ROW_TITLE_MAX), sentence)
  assert.ok(missionDisplayTitle({ objective: sentence }).endsWith("…"))
})

test("a summary row's objective label, or a compact map's excerpt, gives the full map's row title", () => {
  const long = "word ".repeat(120)
  const objectives = ["Fix the v1.2 parser. Then add tests.", "  Audit \t login\n\n and   everything else", long,
    `${"a".repeat(501)}.b more`, `${"a".repeat(500)}.b more`, `${"a".repeat(500)}. More`, `${"a".repeat(499)}.\tMore`, `${"é ".repeat(260)}, then, a clause`,
    `${"  ".repeat(400)}Leading whitespace runs. Then`, `${"x  ".repeat(300)}`, "Line one\r\nLine two"]
  for (const objective of objectives) {
    const summary = missionSummary({ objective, id: "msn", status: "active", coordinatorSessionId: "ses", actors: [], tasks: [], updatedAt: 1, revision: 1 } as never)
    assert.equal(missionDisplayTitle(summary, MISSION_ROW_TITLE_MAX), missionDisplayTitle({ objective }, MISSION_ROW_TITLE_MAX), JSON.stringify(objective.slice(0, 40)))
    assert.equal(missionDisplayTitle({ excerpt: missionObjectiveLabel(objective) }, MISSION_ROW_TITLE_MAX), missionDisplayTitle({ objective }, MISSION_ROW_TITLE_MAX))
  }
})

test("short titles keep the first sentence and cut long text at a clause or word", () => {
  assert.equal(missionShortTitle("Fix the v1.2 parser. Then add tests."), "Fix the v1.2 parser")
  assert.equal(missionShortTitle("Audit login\nand everything else"), "Audit login")
  const clause = missionShortTitle("Migrate the persistence layer to the new storage engine, then remove the legacy adapters and tests")
  assert.equal(clause, "Migrate the persistence layer to the new storage engine…")
  const words = missionShortTitle("word ".repeat(30))
  assert.ok(Array.from(words).length <= 60 && words.endsWith("…") && !words.includes(" …"))
})

test("relative times are localized", () => {
  const now = Date.UTC(2026, 9, 9, 12)
  assert.equal(missionRelativeTime(now - 2 * 3_600_000, "en", now), "2 hours ago")
  assert.equal(missionRelativeTime(now - 10_000, "en", now), "now")
})
