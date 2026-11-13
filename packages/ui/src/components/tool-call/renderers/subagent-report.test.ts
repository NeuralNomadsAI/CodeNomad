import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { findLatestSubagentReport, isBackgroundSubagentLaunch, parseSubagentReport, SUBAGENT_REPORT_SCAN_LIMIT } from "./subagent-report"

const report = (child: string, state: string, body: string) =>
  `<subagent sessionID="${child}" state="${state}" description="Nest">\n${body}\n</subagent>`

function session(entries: Array<{ id: string; createdAt: number; text?: string; synthetic?: boolean }>) {
  const messages = new Map(entries.map(entry => [entry.id, {
    createdAt: entry.createdAt,
    partIds: entry.text === undefined ? [] : [`${entry.id}-text`],
    parts: entry.text === undefined ? {} : { [`${entry.id}-text`]: { data: { type: "text", synthetic: entry.synthetic ?? true, text: entry.text } } },
  }]))
  return { ids: entries.map(entry => entry.id), get: (id: string) => messages.get(id) }
}

describe("background subagent reports", () => {
  it("recognizes only a background launch acknowledgement", () => {
    assert.equal(isBackgroundSubagentLaunch({ status: "completed", metadata: { sessionID: "ses_child", status: "running" } }), true)
    assert.equal(isBackgroundSubagentLaunch({ status: "completed", metadata: { sessionID: "ses_child", status: "completed" } }), false)
    assert.equal(isBackgroundSubagentLaunch({ status: "running", metadata: { status: "running" } }), false)
    assert.equal(isBackgroundSubagentLaunch(undefined), false)
  })

  it("parses the report tag, keeping a still-running list in the body", () => {
    const body = "Partial\n\nBackground work still running:\n- subagent (general, sessionID: ses_leaf): Leaf"
    assert.deepEqual(parseSubagentReport(report("ses_child", "running", body)), { childId: "ses_child", state: "running", body })
    assert.equal(parseSubagentReport("<subagent sessionID=\"ses_child\" state=\"unknown\">\nx\n</subagent>"), null)
    assert.equal(parseSubagentReport("plain text"), null)
  })

  it("picks the child's latest report after its launch, whatever the listing order", () => {
    const { ids, get } = session([
      { id: "msg_0", createdAt: 1, text: report("ses_child", "completed", "Before launch") },
      { id: "msg_1", createdAt: 2 },
      // Final listed before the intermediate, as a 2.3 inbox flush can list them.
      { id: "msg_3", createdAt: 5, text: report("ses_child", "completed", "Final") },
      { id: "msg_2", createdAt: 4, text: report("ses_child", "running", "Intermediate") },
      { id: "msg_4", createdAt: 6, text: report("ses_other", "completed", "Other child") },
      { id: "msg_5", createdAt: 7, text: report("ses_child", "completed", "Typed by a user"), synthetic: false },
    ])
    assert.deepEqual(findLatestSubagentReport(ids, get, "ses_child", "msg_1"),
      { childId: "ses_child", state: "completed", body: "Final", createdAt: 5, messageId: "msg_3" })
    assert.equal(findLatestSubagentReport(ids.slice(0, 2), get, "ses_child", "msg_1"), null)
  })

  it("breaks creation-time ties by message id and bounds the scan", () => {
    const { ids, get } = session([
      { id: "msg_a", createdAt: 3, text: report("ses_child", "running", "First") },
      { id: "msg_b", createdAt: 3, text: report("ses_child", "completed", "Second") },
    ])
    assert.equal(findLatestSubagentReport(ids, get, "ses_child")?.body, "Second")
    const padding = Array.from({ length: SUBAGENT_REPORT_SCAN_LIMIT }, (_, index) => ({ id: `msg_p${index}`, createdAt: 10 + index }))
    const bounded = session([{ id: "msg_old", createdAt: 1, text: report("ses_child", "completed", "Too old") }, ...padding])
    assert.equal(findLatestSubagentReport(bounded.ids, bounded.get, "ses_child"), null)
  })
})
