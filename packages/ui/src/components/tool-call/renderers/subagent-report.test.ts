import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { cachedSubagentDeliveries, indexSubagentDeliveries, isBackgroundSubagentLaunch, latestReportForLaunch, parseSubagentReport, SUBAGENT_REPORT_SCAN_LIMIT } from "./subagent-report"

const report = (child: string, state: string, body: string) =>
  `<subagent sessionID="${child}" state="${state}" description="Nest">\n${body}\n</subagent>`

type Entry = { id: string; createdAt: number; text?: string; synthetic?: boolean; launch?: { child: string; created?: number; ran?: number } }

function session(entries: Entry[]) {
  const messages = new Map(entries.map(entry => {
    const data = entry.launch
      ? { type: "tool", tool: "subagent", ...(entry.launch.created === undefined ? {} : { time: { created: entry.launch.created, ...(entry.launch.ran ? { ran: entry.launch.ran } : {}) } }),
        state: { status: "completed", metadata: { sessionID: entry.launch.child, status: "running" } } }
      : entry.text === undefined ? undefined : { type: "text", synthetic: entry.synthetic ?? true, text: entry.text }
    return [entry.id, { createdAt: entry.createdAt, partIds: data ? [`${entry.id}-part`] : [], parts: data ? { [`${entry.id}-part`]: { data } } : {} }]
  }))
  const index = indexSubagentDeliveries(entries.map(entry => entry.id), id => messages.get(id)) as Map<string, any> & { read?: unknown }
  const read = (messageId: string, partId: string) => (messages.get(messageId)?.parts[partId]?.data as { text?: string } | undefined)?.text
  return Object.assign(index, { latest: (child: string, at: number) => latestReportForLaunch(index.get(child), at, read), messages })
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

  it("picks the latest report after the launch by time, whatever the listing order", () => {
    const index = session([
      // Listed before the launch yet delivered after it; an older one listed after it.
      { id: "msg_4", createdAt: 6, text: report("ses_child", "completed", "Final") },
      { id: "msg_0", createdAt: 1, text: report("ses_child", "completed", "Before launch") },
      { id: "msg_1", createdAt: 2, launch: { child: "ses_child" } },
      { id: "msg_3", createdAt: 4, text: report("ses_child", "running", "Intermediate") },
      { id: "msg_5", createdAt: 7, text: report("ses_other", "completed", "Other child") },
      { id: "msg_6", createdAt: 8, text: report("ses_child", "completed", "Typed by a user"), synthetic: false },
    ])
    assert.deepEqual(index.latest("ses_child", 2),
      { childId: "ses_child", state: "completed", body: "Final", createdAt: 6, messageId: "msg_4" })
    assert.equal(index.latest("ses_child", 9), null)
    assert.equal(index.latest("ses_missing", 2), null)
  })

  it("keeps each call's own report when the same child is continued", () => {
    const index = session([
      { id: "msg_1", createdAt: 1, launch: { child: "ses_child", created: 2 } },
      { id: "msg_2", createdAt: 3, text: report("ses_child", "completed", "Result A") },
      { id: "msg_3", createdAt: 4, launch: { child: "ses_child", created: 5 } },
      { id: "msg_4", createdAt: 6, text: report("ses_child", "completed", "Result B") },
    ])
    assert.equal(index.latest("ses_child", 2)?.body, "Result A")
    assert.equal(index.latest("ses_child", 5)?.body, "Result B")
  })

  it("breaks creation-time ties by message id and bounds the scan", () => {
    const tied = session([
      { id: "msg_a", createdAt: 3, text: report("ses_child", "running", "First") },
      { id: "msg_b", createdAt: 3, text: report("ses_child", "completed", "Second") },
    ])
    assert.equal(tied.latest("ses_child", 0)?.body, "Second")
    const padding = Array.from({ length: SUBAGENT_REPORT_SCAN_LIMIT }, (_, index) => ({ id: `msg_p${index}`, createdAt: 10 + index }))
    const bounded = session([{ id: "msg_old", createdAt: 1, text: report("ses_child", "completed", "Too old") }, ...padding])
    assert.equal(bounded.latest("ses_child", 0), null)
  })

  it("bounds a continuation at its execution start, not at its argument streaming", () => {
    const index = session([
      { id: "msg_1", createdAt: 1, launch: { child: "ses_child", created: 1 } },
      // The continuation streamed its arguments from 2 and ran at 4; the child reported at 3.
      { id: "msg_2", createdAt: 2, launch: { child: "ses_child", created: 2, ran: 4 } },
      { id: "msg_3", createdAt: 3, text: report("ses_child", "completed", "First period") },
      { id: "msg_4", createdAt: 5, text: report("ses_child", "completed", "Second period") },
    ])
    assert.equal(index.latest("ses_child", 1)?.body, "First period")
    assert.equal(index.latest("ses_child", 4)?.body, "Second period")
  })

  it("joins a call continued before its first report to the next period that reports", () => {
    const index = session([
      { id: "msg_1", createdAt: 1, launch: { child: "ses_child", created: 1 } },
      { id: "msg_2", createdAt: 2, launch: { child: "ses_child", created: 2 } },
      { id: "msg_3", createdAt: 3, launch: { child: "ses_child", created: 3 } },
      { id: "msg_4", createdAt: 4, text: report("ses_child", "completed", "Joined result") },
    ])
    assert.equal(index.latest("ses_child", 1)?.body, "Joined result")
    assert.equal(index.latest("ses_child", 3)?.body, "Joined result")
  })

  it("builds one index per session revision and resident message list", () => {
    let builds = 0
    const build = () => { builds += 1; return new Map() }
    const ids = ["msg_1"]
    const first = cachedSubagentDeliveries(ids, 1, build)
    assert.equal(cachedSubagentDeliveries(ids, 1, build), first)
    assert.equal(builds, 1)
    // Eviction or reload restarts revisions: a new list, or a list that changed length, rebuilds.
    cachedSubagentDeliveries(["msg_1"], 1, build)
    ids.push("msg_2"); cachedSubagentDeliveries(ids, 1, build)
    cachedSubagentDeliveries(ids, 2, build)
    assert.equal(builds, 4)
  })

  it("keeps report bodies in the store: the index holds references and skips evicted reports", () => {
    const index = session([
      { id: "msg_1", createdAt: 1, launch: { child: "ses_child", created: 1 } },
      { id: "msg_2", createdAt: 2, text: report("ses_child", "running", "Older") },
      { id: "msg_3", createdAt: 3, text: report("ses_child", "completed", "x".repeat(1_000)) },
    ])
    assert.equal(JSON.stringify([...index]).includes("x".repeat(100)), false, "no body retained by the index")
    assert.equal(index.latest("ses_child", 1)?.body.length, 1_000)
    index.messages.delete("msg_3")
    assert.equal(index.latest("ses_child", 1)?.body, "Older")
  })
})
