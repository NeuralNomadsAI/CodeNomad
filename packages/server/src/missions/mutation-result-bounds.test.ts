import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_INSPECT_OUTPUT_LIMIT, contentDigest, contentText } from "./inspect-view"
import { INTERRUPT_RECEIPT_BUDGET_BYTES } from "./interrupt-receipts"
import { missionPluginFixture } from "./mission-plugin-fixture"
import { buildAssignmentPrompt } from "./recipes"
import { boundedInterruption } from "./tool-result"

type Tool = Awaited<ReturnType<ReturnType<typeof missionPluginFixture>["plugin"]>>["tool"]

/** Follows a `{ omittedCharacters, read }` marker through mission.inspect to the whole value. */
async function readMarker(tool: Tool, sessionID: string, marker: { omittedCharacters: number; read: Record<string, unknown> }) {
  let input = marker.read, text = "", json = false
  for (;;) {
    const slice = await tool("inspect", input, sessionID)
    assert.ok(slice.content.length <= MISSION_INSPECT_OUTPUT_LIMIT)
    text += slice.value.content.text; json = slice.value.content.json === true
    if (!slice.value.content.next) break
    input = slice.value.content.next
  }
  assert.equal(text.length, marker.omittedCharacters)
  return json ? JSON.parse(text) : text
}

test("one task's oversized declaration result fits, and its exact canonical prompt is read whole before delegation", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    // Accepted maximum objective and brief that escape five times in the prompt.
    const mission = (await f.control().create({ requestID: "delegate", objective: "&".repeat(20_000), template: "custom" })).mission
    const coordinator = mission.coordinatorSessionId
    const declared = await plugin.tool("delegate", { taskKey: "one-task", title: "One", brief: "&".repeat(20_000), role: "specialist" }, coordinator)
    assert.ok(declared.content.length <= MISSION_INSPECT_OUTPUT_LIMIT, `${declared.content.length} characters`)
    assert.deepEqual([declared.value.disposition, declared.value.task.key, declared.value.contract.taskKey], ["declared", "one-task", "one-task"])
    const marker = declared.value.assignmentPrompt
    assert.equal(typeof marker, "object", "the prompt gave way to its exact read")
    const map = (await f.control().snapshot()).missions.find(value => value.id === mission.id)!
    const prompt = await readMarker(plugin.tool, coordinator, marker)
    assert.equal(prompt, buildAssignmentPrompt(map, map.tasks[0]), "the joined slices are the exact canonical prompt")
    assert.ok(JSON.stringify({ ...declared.value, assignmentPrompt: prompt }, null, 2).length > 200_000, "unbounded, the result would exceed 200,000 characters")
    // The task view rereads the same prompt, bounded the same way.
    const view = await plugin.tool("inspect", { missionID: mission.id, taskKey: "one-task" }, coordinator)
    assert.ok(view.content.length <= MISSION_INSPECT_OUTPUT_LIMIT)
    assert.equal(await readMarker(plugin.tool, coordinator, view.value.assignmentPrompt), prompt)
  } finally { await plugin.dispose() }
})

/** A schema-valid bridge receipt: `roots` conversations, each with up to 64 interrupted descendants. */
function interruptReceipt(roots: number, idLength: number, mark: string) {
  const id = (index: number) => `ses_${mark}${String(index).padStart(8, "0")}`.padEnd(idLength, "x")
  return { complete: false, sessions: Array.from({ length: roots }, (_, root) => {
    const interrupted = 64 - root % 5, complete = root % 5 !== 0
    return { sessionID: id(root), interrupted: root % 3 !== 0, settled: root % 2 === 0, descendants: { observed: 64, interrupted,
      cancelled: root % 4, unconfirmed: complete ? 0 : 1, complete, sessions: Array.from({ length: interrupted }, (_, child) => id(1_000 + root * 64 + child)) } }
  }) }
}

test("an interrupt receipt larger than one result keeps every outcome, pages them when needed, and reads back whole without replaying", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    let mission = (await f.control().create({ requestID: "interrupt", objective: "Stop retired work", template: "custom" })).mission
    const coordinator = mission.coordinatorSessionId
    mission = (await f.control().declare(coordinator, { missionID: mission.id, taskKey: "retired-task", title: "Retired", brief: "Work", role: "specialist",
      blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })).mission
    mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "retire", reason: "Done",
      retireTasks: [{ taskKey: "retired-task" }], addTasks: [], dependencyUpdates: [] })).mission
    let calls = 0, reply = interruptReceipt(100, 30, "a")
    f.bridge.interruptTask = async () => { calls++; return reply }
    const interrupt = () => plugin.tool("interrupt", { missionID: mission.id, taskKey: "retired-task" }, coordinator)
    const outcome = (root: ReturnType<typeof interruptReceipt>["sessions"][number]) => {
      const { descendants: { sessions: _sessions, ...counts }, ...rest } = root
      return { ...rest, descendants: counts }
    }
    for (const [roots, idLength, mark] of [[100, 30, "a"], [200, 240, "b"]] as const) {
      reply = interruptReceipt(roots, idLength, mark)
      assert.ok(JSON.stringify(reply, null, 2).length > 3 * MISSION_INSPECT_OUTPUT_LIMIT, "the whole receipt exceeds one result")
      const result = await interrupt()
      assert.ok(result.content.length <= MISSION_INSPECT_OUTPUT_LIMIT, `${result.content.length} characters`)
      // Honest outcomes: complete, totals over every conversation, and each listed one whole but its IDs.
      assert.equal(result.value.complete, false)
      assert.deepEqual(result.value.totals, { conversations: roots, interrupted: reply.sessions.filter(root => root.interrupted).length,
        settled: reply.sessions.filter(root => root.settled).length, descendants: {
          observed: 64 * roots, interrupted: reply.sessions.reduce((sum, root) => sum + root.descendants.interrupted, 0),
          cancelled: reply.sessions.reduce((sum, root) => sum + root.descendants.cancelled, 0),
          unconfirmed: reply.sessions.reduce((sum, root) => sum + root.descendants.unconfirmed, 0), complete: false } })
      const listed = result.value.sessions.length
      assert.deepEqual(result.value.sessions, reply.sessions.slice(0, listed).map(outcome))
      // The accepted receipt shape (at most 200 conversations, 240-character IDs) keeps every outcome.
      assert.deepEqual([listed, result.value.sessionPage], [roots, undefined], "every outcome fits without its descendant IDs")
      // The whole original receipt reads back exactly, every slice within its bound, without asking the bridge again.
      const before = calls
      assert.deepEqual(await readMarker(plugin.tool, coordinator, result.value.receipt), reply)
      assert.equal(calls, before, "a receipt read never replays the interruption")
      // Another session cannot read it.
      f.native.set("ses_other_root", { id: "ses_other_root", projectID: "project-1", title: "Other", location: { directory: "/repo" } })
      await assert.rejects(plugin.tool("inspect", result.value.receipt.read, "ses_other_root"), /no longer held/)
    }
    // The task's newest interruption replaces its held receipt; the older one is refused, never answered by the newer.
    const older = (await interrupt()).value.receipt
    reply = interruptReceipt(100, 30, "c")
    const newer = (await interrupt()).value.receipt
    await assert.rejects(plugin.tool("inspect", older.read, coordinator), /no longer held/)
    assert.deepEqual(await readMarker(plugin.tool, coordinator, newer), reply)
    // A receipt that fits stays whole.
    reply = interruptReceipt(2, 30, "d")
    assert.deepEqual((await interrupt()).value, reply)
  } finally { await plugin.dispose() }
})

/** A coordinator's retired native task, ready to interrupt through the real executor. */
async function retiredTask(f: ReturnType<typeof missionPluginFixture>, requestID: string) {
  let mission = (await f.control().create({ requestID, objective: "Stop retired work", template: "custom" })).mission
  const coordinator = mission.coordinatorSessionId
  mission = (await f.control().declare(coordinator, { missionID: mission.id, taskKey: "retired-task", title: "Retired", brief: "Work", role: "specialist",
    blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })).mission
  mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: "retire", reason: "Done",
    retireTasks: [{ taskKey: "retired-task" }], addTasks: [], dependencyUpdates: [] })).mission
  return { mission, coordinator }
}

test("a task's newest interruption replaces its held receipt whether the mission is named or not, and a whole result retires it", { timeout: 120_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    const { mission, coordinator } = await retiredTask(f, "replace")
    let calls = 0, reply = interruptReceipt(100, 30, "a")
    f.bridge.interruptTask = async () => { calls++; return reply }
    const interrupt = async (named: boolean, next: ReturnType<typeof interruptReceipt>) => {
      reply = next
      return (await plugin.tool("interrupt", { ...(named ? { missionID: mission.id } : {}), taskKey: "retired-task" }, coordinator)).value
    }
    const refused = (marker: { read: Record<string, unknown> }) => assert.rejects(plugin.tool("inspect", marker.read, coordinator), /no longer held/)
    // Explicit, then implicit: one task, one slot.
    const explicit = (await interrupt(true, interruptReceipt(100, 30, "b"))).receipt
    const implicit = (await interrupt(false, interruptReceipt(100, 30, "c"))).receipt
    await refused(explicit)
    assert.deepEqual(await readMarker(plugin.tool, coordinator, implicit), reply)
    // Implicit, then explicit.
    const named = (await interrupt(true, interruptReceipt(100, 30, "d"))).receipt
    await refused(implicit)
    assert.deepEqual(await readMarker(plugin.tool, coordinator, named), reply)
    // Large, then a small whole result: the older body goes.
    const small = interruptReceipt(1, 30, "e")
    assert.deepEqual(await interrupt(false, small), small, "a small result stays whole")
    await refused(named)
    assert.equal(calls, 4, "reads never call the bridge")
  } finally { await plugin.dispose() }
})

test("held receipts stay within the byte budget across many missions: the newest reconstruct exactly, the evicted refuse", { timeout: 300_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    let calls = 0, reply = interruptReceipt(100, 60, "m000")
    f.bridge.interruptTask = async () => { calls++; return reply }
    const held: Array<{ coordinator: string; marker: { omittedCharacters: number; read: Record<string, unknown> }; receipt: typeof reply }> = []
    for (let index = 0; index < 60; index++) {
      const { mission, coordinator } = await retiredTask(f, `budget-${index}`)
      reply = interruptReceipt(100, 60, `m${String(index).padStart(3, "0")}`)
      const result = await plugin.tool("interrupt", { taskKey: "retired-task" }, coordinator)
      assert.ok(result.content.length <= MISSION_INSPECT_OUTPUT_LIMIT)
      held.push({ coordinator, marker: result.value.receipt, receipt: reply })
      // Deleted missions' receipts count against the same budget.
      if (index % 2) await f.control().delete({ missionID: mission.id, requestID: `delete-${index}`, expectedRevision: (await f.control().mission(mission.id)).mission!.revision })
    }
    const each = 2 * contentText(held[0].receipt).length, kept = Math.floor(INTERRUPT_RECEIPT_BUDGET_BYTES / each)
    assert.ok(kept > 10 && kept < 60, `${kept} receipts of ${each} bytes fit the budget`)
    const before = calls
    // Oldest first: the evicted refuse, the held reconstruct exactly.
    for (const [index, { coordinator, marker, receipt }] of held.entries()) {
      if (index < held.length - kept) await assert.rejects(plugin.tool("inspect", marker.read, coordinator), /no longer held/, `receipt ${index}`)
      else assert.deepEqual(await readMarker(plugin.tool, coordinator, marker), receipt, `receipt ${index}`)
    }
    assert.equal(calls, before, "no read called the bridge")
  } finally { await plugin.dispose() }
})

test("interrupt outcomes too many for one result page in receipt order, each page within its bound", () => {
  // More conversations than the bridge reports, to exercise the page past the receipt shape.
  const receipt = interruptReceipt(600, 240, "p")
  let held: unknown
  const bounded = boundedInterruption(receipt, value => { held = value; return contentDigest(contentText(value)) }) as {
    sessions: unknown[]; sessionPage: { returned: number; total: number }; totals: { conversations: number }; receipt: { omittedCharacters: number } }
  assert.ok(JSON.stringify(bounded, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.deepEqual([bounded.sessionPage.total, bounded.sessions.length, bounded.totals.conversations], [600, bounded.sessionPage.returned, 600])
  assert.ok(bounded.sessionPage.returned > 100 && bounded.sessionPage.returned < 600)
  const outcomes = receipt.sessions.map(({ descendants: { sessions: _sessions, ...counts }, ...rest }) => ({ ...rest, descendants: counts }))
  assert.deepEqual(bounded.sessions, outcomes.slice(0, bounded.sessionPage.returned), "whole outcomes, in receipt order")
  assert.ok(JSON.stringify({ ...bounded, sessions: outcomes.slice(0, bounded.sessionPage.returned + 1) }, null, 2).length > MISSION_INSPECT_OUTPUT_LIMIT,
    "as many outcomes as fit")
  assert.equal(held, receipt)
  assert.equal(bounded.receipt.omittedCharacters, contentText(receipt).length)
})

test("a frontier larger than one result gives way to its exact read in every mutation result, and a wide revision pages its tasks", { timeout: 300_000 }, async () => {
  const f = missionPluginFixture(), plugin = await f.plugin()
  try {
    let mission = (await f.control().create({ requestID: "frontier", objective: "Wide plan", template: "custom" })).mission
    const coordinator = mission.coordinatorSessionId
    const key = (index: number) => `task-${String(index).padStart(5, "0")}-`.padEnd(64, "k")
    for (let added = 0; added < 1_700; added += 24) {
      mission = (await f.control().revise(coordinator, { missionID: mission.id, expectedRevision: mission.revision, requestID: `plan-${added}`, reason: "More",
        retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: Math.min(24, 1_700 - added) }, (_, index) => ({ taskKey: key(added + index),
          title: `Task ${added + index}`, brief: "Brief", role: "specialist", blockedBy: [] })) })).mission
    }
    assert.ok(JSON.stringify(mission.frontier, null, 2).length > MISSION_INSPECT_OUTPUT_LIMIT, "the frontier alone exceeds one result")
    const frontierOf = async (result: { content: string; value: { frontier: { omittedCharacters: number; read: Record<string, unknown> } } }) => {
      assert.ok(result.content.length <= MISSION_INSPECT_OUTPUT_LIMIT, `${result.content.length} characters`)
      return readMarker(plugin.tool, coordinator, result.value.frontier)
    }
    const current = async () => (await f.control().snapshot()).missions.find(value => value.id === mission.id)!
    const declared = await plugin.tool("delegate", { taskKey: "extra", title: "Extra", brief: "Extra work", role: "specialist" }, coordinator)
    assert.deepEqual(await frontierOf(declared), (await current()).frontier)
    assert.equal(typeof declared.value.assignmentPrompt, "string", "a prompt that fits stays whole")
    const reported = await plugin.tool("report", { taskKey: key(0), outcome: "completed", summary: "Done", evidence: [], next: [] }, coordinator)
    assert.deepEqual(await frontierOf(reported), (await current()).frontier)
    const briefed = await plugin.tool("briefing", { requestID: "auto", summary: "Wide", achieved: [], ongoing: [], obstacles: [], next: [] }, coordinator)
    assert.deepEqual(await frontierOf(briefed), (await current()).frontier)
    // One revision rewires every waiting task: its result lists the whole tasks that fit, in map order, and counts the rest.
    const latest = await current()
    const revised = await plugin.tool("revise", { expectedRevision: latest.revision, requestID: "rewire", reason: "Order", retireTasks: [], addTasks: [],
      dependencyUpdates: Array.from({ length: 1_699 }, (_, index) => ({ taskKey: key(index + 1), blockedBy: ["extra"] })) }, coordinator)
    assert.ok(revised.content.length <= MISSION_INSPECT_OUTPUT_LIMIT, `${revised.content.length} characters`)
    const rewired = (await current()).tasks.filter(task => task.key !== "extra" && task.key !== key(0))
    assert.ok(revised.value.taskPage.returned > 0 && revised.value.taskPage.returned < 1_699)
    assert.deepEqual([revised.value.tasks.length, revised.value.taskPage.total], [revised.value.taskPage.returned, 1_699])
    assert.deepEqual(revised.value.tasks.map((task: { key: string }) => task.key), rewired.slice(0, revised.value.taskPage.returned).map(task => task.key))
    assert.ok(revised.value.tasks.every((task: { blockedBy: string[] }) => task.blockedBy.length === 1 && task.blockedBy[0] === "extra"))
  } finally { await plugin.dispose() }
})
