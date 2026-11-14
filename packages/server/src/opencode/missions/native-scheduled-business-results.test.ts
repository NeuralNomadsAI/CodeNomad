import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "../../missions/control"
import type { MissionStorage } from "../../missions/journal"
import { missionBusinessMethods, missionBusinessResult, type MissionBusinessControl } from "../../missions/business-control"
import { contentText, MISSION_INSPECT_OUTPUT_LIMIT } from "../../missions/inspect-view"
import { setupMissionsBusiness } from "../missions-plugin"
import { executeNativeScheduledBusiness } from "./native-scheduled-business-rpc"
import { NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES } from "./native-schedule-transport"

const rootID = "ses_root", current = () => true as const
type Tool = { name: string; execute(input: unknown, context: any): Promise<{ content: string }> }
async function fixture(t: test.TestContext, unicode = false) {
  const values = new Map<string, any>()
  let writes = 0, now = 1_000
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { writes++; values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      return { entries: keys.slice(0, limit).map(key => ({ key, value: structuredClone(values.get(key)) })),
        ...(keys.length > limit ? { next: keys[limit - 1] } : {}) }
    },
  }
  const session = { id: rootID, projectID: "project", title: "Coordinator", location: { directory: "/repo" } }
  const control = new MissionControl({ project: { id: "project", canonical: "/repo", location: session.location }, storage, now: () => now++,
    sessions: { get: async () => session, create: async () => { throw new Error("Unexpected root creation") }, prompt: async () => {}, synthetic: async () => {} } })
  let { mission } = await control.create({ requestID: "large-result", coordinatorSessionID: rootID, template: "custom",
    objective: unicode ? "&".repeat(20_000) : "Work" })
  const keys = Array.from({ length: 60 }, (_, i) => `task-${String(i).padStart(2, "0")}${unicode ? "x".repeat(57) : ""}`)
  for (let batch = 0; batch < 3; batch++) {
    ;({ mission } = await control.revise(rootID, { missionID: mission.id, expectedRevision: mission.revision, requestID: `seed-${batch}`, reason: "Seed",
      addTasks: keys.slice(batch * 20, batch * 20 + 20).map(taskKey => ({ taskKey, title: unicode ? "\u0800".repeat(240) : taskKey,
        role: "specialist", brief: (unicode ? "\u0800" : "x").repeat(20_000), blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })),
      retireTasks: [], dependencyUpdates: [] }))
  }
  assert.equal(mission.revision, 4)
  const binding = { documentID: "document", passageID: "passage", missionID: mission.id, rootID }
  const runtime = { businessSelection: async () => ({ readSessionID: rootID }),
    executeBusiness: async (_sessionID: string, _entry: unknown, use: (control: MissionControl) => Promise<unknown>) => ({ value: await use(control) })
  } as unknown as Parameters<typeof executeNativeScheduledBusiness>[0]
  const wireBytes: number[] = []
  let loseReply = false
  const facade = Object.fromEntries(missionBusinessMethods.map(method => [method, async (...args: unknown[]) => {
    const result = await executeNativeScheduledBusiness(runtime, { current, signal: new AbortController().signal },
      { sessionID: rootID, binding, incarnation: {}, method, args }, binding)
    // Include the native HTTP output envelope in the measured byte count.
    const wire = JSON.stringify({ output: result })
    wireBytes.push(Buffer.byteLength(wire))
    assert.ok(Buffer.byteLength(wire) <= NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES)
    if (loseReply) { loseReply = false; throw new Error("Lost reply after commit") }
    return (JSON.parse(wire).output as { value: unknown }).value
  }])) as unknown as MissionBusinessControl
  const tools = async (selected: MissionBusinessControl) => {
    const definitions: Tool[] = []
    const dispose = await setupMissionsBusiness({ session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (add: (draft: any) => void) => { add({ namespace() {}, add: (tool: Tool) => definitions.push(tool) }); return { dispose: async () => {} } } },
    } as never, async () => ({ control: selected, readSessionID: rootID, current, beforeTool: async () => {} }))
    t.after(dispose)
    return async (name: string, input: unknown) => JSON.parse((await definitions.find(tool => tool.name === name)!.execute(input,
      { sessionID: rootID, messageID: "msg_result", id: "call_result", progress: async () => {} })).content)
  }
  return { control, mission, keys, values, wireBytes, writes: () => writes, loseReply: () => { loseReply = true },
    ordinary: await tools(control), scheduled: await tools(facade) }
}

for (const unicode of [false, true]) test(`scheduled revision: 60 x 20,000 briefs, exact ordinary result, lost reply replay (${unicode ? "three-byte BMP" : "ASCII"})`, async t => {
  const f = await fixture(t, unicode)
  const revision = { expectedRevision: 4, requestID: "lost-revision", reason: "Rewire",
    dependencyUpdates: f.keys.map((taskKey, index) => ({ taskKey, blockedBy: unicode ? f.keys.slice(Math.max(0, index - 24), index) : [] })) }
  assert.ok(Buffer.byteLength(JSON.stringify(revision)) < NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES)
  f.loseReply()
  await assert.rejects(f.scheduled("revise", revision), /Lost reply/)
  assert.equal((await f.control.mission(f.mission.id)).mission!.revision, 5)
  const writes = f.writes()
  const actual = await f.scheduled("revise", revision)
  assert.equal(f.writes(), writes, "original requestID replays the committed event without another write")
  const expected = await f.ordinary("revise", revision)
  assert.deepEqual(actual, expected, "same tool-facing result, including reads and page metadata")
  assert.ok(contentText(actual).length <= MISSION_INSPECT_OUTPUT_LIMIT)
  if (unicode) assert.ok(actual.taskPage, "compact affected tasks also page when needed")
  t.diagnostic(`request=${Buffer.byteLength(JSON.stringify(revision))} bytes; response=${f.wireBytes.at(-1)} bytes; revision=5; writes-on-replay=0`)
})

test("scheduled native declaration and task/list inspections retain exact omission reads and slices", async t => {
  const f = await fixture(t, true)
  const input = { taskKey: "huge-prompt", title: "Prompt", role: "specialist", brief: "&".repeat(20_000) }
  const declared = await f.scheduled("delegate", input)
  assert.ok(declared.assignmentPrompt.read, "escaped objective and brief require a prompt read")
  // A repeated declaration has the same disposition on both paths.
  assert.deepEqual(await f.scheduled("delegate", input), await f.ordinary("delegate", input))
  const inspect = { taskKey: input.taskKey }
  const view = await f.scheduled("inspect", inspect)
  assert.deepEqual(view, await f.ordinary("inspect", inspect))
  assert.ok(view.assignmentPrompt.read)
  let read = view.assignmentPrompt.read, joined = ""
  do {
    const slice = await f.scheduled("inspect", read)
    assert.deepEqual(slice, await f.ordinary("inspect", read))
    joined += slice.content.text
    read = slice.content.next
  } while (read)
  assert.match(joined, /&amp;&amp;/)
  for (const inspect of [{}, { list: true }, { taskOffset: 24 }]) {
    assert.deepEqual(await f.scheduled("inspect", inspect), await f.ordinary("inspect", inspect))
  }
  const report = { taskKey: input.taskKey, outcome: "completed", summary: "\u0800".repeat(20_000), evidence: ["\u0800".repeat(2_000)] }
  await f.scheduled("report", report)
  assert.deepEqual(await f.scheduled("report", report), await f.ordinary("report", report))
  const { mission } = await f.control.mission(f.mission.id)
  const reportValue = { mission: mission!, taskKey: input.taskKey, disposition: "reported" }
  assert.deepEqual(missionBusinessResult("reportNative", [{}, report], reportValue), missionBusinessResult("report", [rootID, report], reportValue))
  const briefing = { requestID: "bounded-briefing", basedOnRevision: mission!.revision, summary: "\u0800".repeat(1_200), achieved: [], ongoing: [], obstacles: [], next: [] }
  assert.deepEqual(await f.scheduled("briefing", briefing), await f.ordinary("briefing", briefing))
  let artifact: Record<string, unknown> = { value: "valid journal artifact" }
  for (let depth = 0; depth < 18; depth++) artifact = { nested: artifact }
  await f.control.report(rootID, { taskKey: f.keys[0], outcome: "completed", summary: "Nested evidence", evidence: [], next: [], final: false, artifact: artifact as never })
  assert.deepEqual(await f.scheduled("inspect", { taskKey: f.keys[0] }), await f.ordinary("inspect", { taskKey: f.keys[0] }))
  t.diagnostic(`largest response=${Math.max(...f.wireBytes)} bytes; general UTF-8 ceiling=300,000 bytes plus fixed envelopes`)
})
