import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { desktopPlugin } from "./desktop-plugin"
import { retireNativePassageBusiness, prepareNativePassageSession } from "./native-passage-business"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"
import { AUTOMATIC_BRIEFINGS, USER_FACING_TEXT } from "../../missions/recipes"

test("desktop registers passage mission tools independently of backend presence; descendants read the isolated map", async () => {
  const f = await passageFixture(false)
  const plugin = desktopPlugin([])
  const dispose = await plugin.setup(f.context as never)
  try {
    assert.deepEqual([...f.tools.keys()], ["inspect", "delegate", "revise", "report", "briefing"])
    await f.start()
    const child = "ses_native_child"
    f.sessions.set(child, { ...f.sessions.get(f.passage.coordinatorSessionID)!, id: child, parentID: f.passage.coordinatorSessionID })
    const tool = { sessionID: child, messageID: "msg_inspect", id: "call_inspect", progress: async () => {} }
    const result = JSON.parse((await f.tools.get("inspect")!.execute({}, tool)).content)
    assert.equal(result.mission.id, f.passage.missionID)
    await assert.rejects(f.tools.get("inspect")!.execute({ missionID: "msn_foreign" }, tool), /identity differs/)
    // The passage coordinator receives the same plain-language report and automatic briefing guidance.
    const contextEvent = (sessionID: string) => ({ sessionID, system: [] as Array<{ type: string; text: string }>, tools: { mission_briefing: {} } as Record<string, unknown> })
    const coordinator = contextEvent(f.passage.coordinatorSessionID), descendant = contextEvent(child)
    await f.hooks.get("context")!(coordinator); await f.hooks.get("context")!(descendant)
    const system = coordinator.system.map(part => part.text).join("\n")
    assert.ok(system.includes(USER_FACING_TEXT) && system.includes(AUTOMATIC_BRIEFINGS))
    assert.match(system, /whenever you start waiting on a human/)
    assert.ok(coordinator.tools.mission_briefing)
    assert.equal(descendant.tools.mission_briefing, undefined)
    await f.finish()
    assert.equal((await f.passage.journal.snapshot()).missions[0].status, "completed")
    // Ordinary one-time use still requires the backend-presence registration.
    f.sessions.set("ses_ordinary", { id: "ses_ordinary", projectID: "project", location: { directory: f.root } })
    await assert.rejects(f.tools.get("inspect")!.execute({}, { ...tool, sessionID: "ses_ordinary" }), /no longer available/)
  } finally { if (typeof dispose === "function") await dispose(); await f.dispose() }
})

test("explicit independent task uses frozen native ENV/IDs and remains part of passage quiescence", async () => {
  const f = await passageFixture()
  try {
    await f.start()
    const tool = { sessionID: f.passage.coordinatorSessionID, messageID: "msg_delegate", id: "call_delegate", progress: async () => {} }
    const delegated = JSON.parse((await f.tools.get("delegate")!.execute({ taskKey: "independent", title: "Independent work",
      brief: "Bounded independent task", role: "specialist", blockedBy: [],
      executionMode: { kind: "independent", reason: "lifetime", explanation: "Needs its own bounded root lifetime" } }, tool)).content)
    const actor = delegated.mission.tasks[0].actorSessionId as string
    assert.notEqual(actor, f.passage.coordinatorSessionID)
    assert.deepEqual(f.counts(), { creates: 2, sends: 2, environments: 2 })
    f.states.get(actor)!.active = true
    const observe = async () => observeNativePassageSettlement({ document: (await f.calendar.read("schedule"))!,
      storage: f.storage, native: f.observation, directory: f.root, current: () => true, signal: new AbortController().signal })
    assert.equal(await observe(), undefined)
    await f.tools.get("report")!.execute({ taskKey: "independent", outcome: "completed", summary: "Independent root done" }, { ...tool, sessionID: actor })
    f.states.get(actor)!.active = false
    await f.finish()
    assert.equal((await observe())?.result.outcome, "completed")
    assert.deepEqual(f.counts(), { creates: 2, sends: 3, environments: 3 })
  } finally { await f.dispose() }
})

test("restart restores real business reports from pending journal without rearming a Job or replaying a prompt", async () => {
  const f = await passageFixture()
  try {
    await f.start()
    const doc = (await f.calendar.read("schedule"))!
    await f.calendar.setState(doc.id, doc.revision, "paused", () => true)
    retireNativePassageBusiness(f.context.location)
    await f.finish()
    assert.equal((await f.passage.journal.snapshot()).missions[0].status, "completed")
    assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
    await assert.rejects(prepareNativePassageSession(f.context, f.passage.coordinatorSessionID), /Resume the schedule/)
    assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
  } finally { await f.dispose() }
})
