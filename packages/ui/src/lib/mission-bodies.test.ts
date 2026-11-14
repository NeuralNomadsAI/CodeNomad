import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionPanelMap } from "../../../server/src/api-types"
import { missionBodyPresent, missionOwnBody } from "./mission-bodies"

const descriptor = (text: string) => ({ characters: text.length, digest: "d".repeat(43) })
const base = { version: 1 as const, id: "mission", projectID: "project", projectCanonical: "/repo", template: "custom" as const, status: "active" as const,
  coordinatorSessionId: "ses", actors: [], frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 1, historyTruncated: false }
const report = { id: "rep", taskKey: "task", sessionId: "ses", outcome: "completed" as const, createdAt: 1 }

/** A compact map: descriptors only, of a summary, an empty notes field, an empty and a full list, an artifact. */
const compact: MissionPanelMap = { ...base, excerpt: "Objective", bodies: { objective: descriptor("Objective"), notes: descriptor("") }, tasks: [], history: [],
  reports: [{ ...report, excerpt: "Done", bodies: { summary: descriptor("Done"), next: descriptor("[]"), evidence: descriptor("[\"proof\"]"), artifact: descriptor("{}") } }] }
/** The same values in a passage's full map, without descriptors. */
const full: MissionMap = { ...base, objective: "Objective", notes: "", tasks: [], history: [],
  reports: [{ ...report, summary: "Done", next: [], evidence: ["proof"], artifact: {} }] }

test("a body's presence comes from a compact map's descriptor, or a passage's own value, alike", () => {
  const at = (field: string) => ({ kind: "report" as const, reportId: "rep", field })
  for (const map of [compact, full]) {
    const label = map === compact ? "compact" : "full"
    assert.deepEqual([missionBodyPresent(map, { kind: "mission", field: "objective" }, "text"), missionBodyPresent(map, { kind: "mission", field: "notes" }, "text"),
      missionBodyPresent(map, { kind: "mission", field: "summary" }, "text")], [true, false, false], `${label}: text with characters, empty, absent`)
    assert.deepEqual([missionBodyPresent(map, at("next"), "list"), missionBodyPresent(map, at("evidence"), "list")], [false, true], `${label}: an empty list, a list with items`)
    assert.deepEqual([missionBodyPresent(map, at("artifact"), "value"), missionBodyPresent(map, { kind: "report", reportId: "other", field: "artifact" }, "value")],
      [true, false], `${label}: a value, no such report`)
  }
  assert.equal(missionBodyPresent(undefined, { kind: "mission", field: "objective" }, "text"), false)
})

test("only a passage's full map gives a body's own value", () => {
  assert.equal(missionOwnBody(compact, { kind: "mission", field: "objective" }), undefined)
  assert.equal(missionOwnBody(full, { kind: "mission", field: "objective" }), "Objective")
  assert.deepEqual(missionOwnBody(full, { kind: "report", reportId: "rep", field: "evidence" }), ["proof"])
})
