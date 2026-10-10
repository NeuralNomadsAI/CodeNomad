import assert from "node:assert/strict"
import test from "node:test"
import { applyMissionLifecycle } from "./mission-lifecycle"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { readNativeControlFamily } from "../../missions/native-session-family"
import { interruptNativeMissionFamily } from "../../missions/native-family-interrupt"

/** A native-like family: 3 levels x fan-out 3 of busy background subagents.
 * Interrupting a child delivers its "Subagent cancelled" result to the parent
 * inbox and wakes that parent, as native SubagentCompletion.deliver does. */
function fixture(action: "pause" | "stop" | "start", options: { stuck?: string } = {}) {
  const location = { directory: "/repo" }
  const native = new Map<string, any>([["ses_coordinator", { id: "ses_coordinator", projectID: "project", location }]])
  const depth = new Map([["ses_coordinator", 0]])
  const add = (parentID: string, level: number) => {
    for (let index = 0; index < 3; index++) {
      const id = `${parentID}_${index}`
      native.set(id, { id, parentID, projectID: "project", location })
      depth.set(id, level)
      if (level < 3) add(id, level + 1)
    }
  }
  add("ses_coordinator", 1)
  const running = new Set(native.keys())
  const inboxes = new Map<string, any[]>([...native.keys()].map(id => [id, id === "ses_coordinator" ? [] : [{ id: `inb_${id}`, type: "synthetic", payload: { text: "queued work" } }]]))
  const calls: Array<{ kind: string; sessionID: string }> = []
  let delivered = 0
  const mission: any = {
    id: "msn_fixture", projectID: "project", coordinatorSessionId: "ses_coordinator", status: action === "stop" ? "stopped" : "active",
    runState: action === "start" ? "running" : action === "pause" ? "paused" : "stopped",
    actors: [{ sessionId: "ses_coordinator", location }],
    tasks: [{ key: "build", actorSessionId: "ses_coordinator_1", status: "running" }],
    control: { id: "evt_control", action, targets: [{ sessionID: "ses_coordinator", location }], pending: ["ses_coordinator"] },
  }
  const client = {
    rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: [mission] }) }),
    session: {
      get: async ({ sessionID }: any) => structuredClone(native.get(sessionID)),
      list: async ({ parentID }: any) => ({ data: [...native.values()].filter(session => session.parentID === parentID).map(session => structuredClone(session)), cursor: { next: null } }),
      active: async () => Object.fromEntries([...running].map(id => [id, { type: "running" }])),
      interrupt: async ({ sessionID }: any) => {
        calls.push({ kind: "interrupt", sessionID })
        if (sessionID === options.stuck) return { interrupted: false }
        const was = running.delete(sessionID)
        if (was) native.get(sessionID).outcome = "interrupted"
        const parentID = native.get(sessionID)?.parentID
        // Asynchronous native delivery that resumes the parent.
        if (was && parentID) queueMicrotask(() => {
          delivered++
          inboxes.get(parentID)!.push({ id: `inb_result_${sessionID}_${delivered}`, type: "synthetic",
            payload: { text: "Subagent cancelled", metadata: { source: "subagent", childID: sessionID, state: "cancelled" } } })
          running.add(parentID)
        })
        return { interrupted: was }
      },
      inbox: {
        list: async ({ sessionID }: any) => structuredClone(inboxes.get(sessionID) ?? []),
        cancel: async ({ sessionID, inboxID }: any) => {
          calls.push({ kind: "cancel", sessionID })
          inboxes.set(sessionID, inboxes.get(sessionID)!.filter(item => item.id !== inboxID))
        },
      },
      environment: async () => {},
      instructions: { entry: { remove: async () => {}, put: async () => {} } },
      synthetic: async (input: any) => ({ id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 1 },
        payload: { text: input.text, description: input.description, metadata: input.metadata } }),
    },
  }
  const manager = {
    list: () => [{ id: "workspace" }], getSharedServiceConnection: async () => ({ client, assertCurrent: () => {} }),
    ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "/repo", getSessionEnvironment: async () => ({}),
  }
  const command = { kind: "lifecycle", input: { missionID: mission.id, operationID: "evt_control", sessionID: "ses_coordinator" } }
  const send = () => applyMissionLifecycle(manager as never, new WorktreeDeletionFence(), "ses_coordinator", command, new AbortController().signal)
  return { client, native, depth, running, inboxes, calls, send, delivered: () => delivered }
}

function firstInterruptDepths(f: ReturnType<typeof fixture>): number[] {
  const seen = new Set<string>()
  return f.calls.filter(call => call.kind === "interrupt" && !seen.has(call.sessionID) && seen.add(call.sessionID)).map(call => f.depth.get(call.sessionID)!)
}

test("Stop interrupts the whole background subagent family deepest first and the coordinator is not re-woken", async () => {
  const f = fixture("stop")
  const result = await f.send()
  const ack = result.nativeAcknowledgement
  if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  const depths = firstInterruptDepths(f)
  assert.equal(depths.length, 40)
  assert.deepEqual(depths, [...depths].sort((left, right) => right - left), "deepest descendants first, coordinator last")
  assert.equal(depths.at(-1), 0)
  assert.equal(f.running.size, 0, "no family session remains running")
  assert.ok(f.delivered() > 0)
  assert.deepEqual(f.inboxes.get("ses_coordinator"), [], "cancelled-child results cannot re-wake a stopped coordinator")
  assert.ok([...f.inboxes.values()].every(inbox => inbox.length === 0), "queued descendant work is cancelled")
  assert.equal(ack.descendants?.observed, 39)
  assert.equal(ack.descendants?.interrupted, 39)
  assert.equal(ack.descendants?.complete, true)
  assert.equal(ack.descendants?.unconfirmed, 0)
  assert.ok((ack.descendants?.cancelled ?? 0) >= 39)
  assert.ok(ack.cancellations.length >= 3 && ack.cancellations.every(item => item.inboxID.startsWith("inb_result_")))
})

test("Pause interrupts the whole family but parks queued deliveries until Play", async () => {
  const f = fixture("pause")
  const ack = (await f.send()).nativeAcknowledgement
  if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  assert.equal(f.calls.some(call => call.kind === "cancel"), false)
  assert.equal(f.running.size, 0)
  assert.ok(f.inboxes.get("ses_coordinator")!.length >= 3, "subagent results stay parked for the resumed coordinator")
  assert.deepEqual(ack.cancellations, [])
  assert.equal(ack.descendants?.complete, true)
  assert.equal(ack.descendants?.interrupted, 39)
})

test("a sub-agent that cannot be confirmed stopped makes the receipt partial", async () => {
  const f = fixture("pause", { stuck: "ses_coordinator_0_0_0" })
  const ack = (await f.send()).nativeAcknowledgement
  if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  assert.equal(ack.descendants?.complete, false)
  assert.equal(ack.descendants?.unconfirmed, 1)
  assert.ok(f.running.has("ses_coordinator_0_0_0"))
})

test("Play tells the coordinator which sub-agent conversations were interrupted", async () => {
  const f = fixture("start")
  f.native.get("ses_coordinator_1").outcome = "interrupted"
  f.native.get("ses_coordinator_2_0").outcome = "interrupted"
  const ack = (await f.send()).nativeAcknowledgement
  if (ack.disposition !== "start-admitted") throw new Error("Wrong ACK")
  assert.match(ack.admission.payload.text, /task build \(ses_coordinator_1\)/)
  assert.match(ack.admission.payload.text, /ses_coordinator_2_0/)
})

for (const action of ["pause", "stop"] as const) {
  test(`${action}: a sub-agent launched by a still-running parent during the passes is interrupted too`, async () => {
    const f = fixture(action)
    const interrupt = f.client.session.interrupt
    f.client.session.interrupt = async (input: any) => {
      const result = await interrupt(input)
      // Its cancelled child's result makes ses_coordinator_0 re-delegate before its own interrupt.
      if (input.sessionID === "ses_coordinator_0_0" && !f.native.has("ses_coordinator_0_late")) {
        f.native.set("ses_coordinator_0_late", { id: "ses_coordinator_0_late", parentID: "ses_coordinator_0", projectID: "project", location: { directory: "/repo" } })
        f.running.add("ses_coordinator_0_late")
      }
      return result
    }
    const ack = (await f.send()).nativeAcknowledgement
    if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
    assert.equal(f.running.has("ses_coordinator_0_late"), false, "the late sub-agent was stopped")
    assert.equal(f.running.size, 0)
    assert.equal(ack.descendants?.complete, true, "complete only after a quiet family read")
    assert.equal(ack.descendants?.observed, 40)
  })

  test(`${action}: a sub-agent the root launched just before its own interrupt is caught by the post-root recheck`, async () => {
    const f = fixture(action)
    const interrupt = f.client.session.interrupt
    f.client.session.interrupt = async (input: any) => {
      if (input.sessionID === "ses_coordinator" && !f.native.has("ses_root_late")) {
        f.native.set("ses_root_late", { id: "ses_root_late", parentID: "ses_coordinator", projectID: "project", location: { directory: "/repo" } })
        f.running.add("ses_root_late")
      }
      return interrupt(input)
    }
    const ack = (await f.send()).nativeAcknowledgement
    if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
    assert.equal(f.running.has("ses_root_late"), false)
    assert.equal(f.running.size, 0, "its cancelled result re-woke the root, which settled again")
    assert.equal(ack.descendants?.complete, true)
    assert.ok(ack.descendants?.sessions.includes("ses_root_late"))
  })

  test(`${action}: a sub-agent that keeps relaunching is never reported as a complete stop`, async () => {
    const f = fixture(action)
    const interrupt = f.client.session.interrupt
    let serial = 0
    f.client.session.interrupt = async (input: any) => {
      const result = await interrupt(input)
      if (input.sessionID.startsWith("ses_coordinator_2")) {
        const id = `ses_coordinator_2_respawn_${++serial}`
        f.native.set(id, { id, parentID: "ses_coordinator_2", projectID: "project", location: { directory: "/repo" } })
        f.running.add(id)
      }
      return result
    }
    const ack = (await f.send()).nativeAcknowledgement
    if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
    assert.equal(ack.descendants?.complete, false)
    assert.ok((ack.descendants?.unconfirmed ?? 0) > 0)
  })

  test(`${action}: a failed family read still interrupts the coordinator and reports a partial stop`, async () => {
    const f = fixture(action)
    const active = f.client.session.active
    let reads = 0
    f.client.session.active = async () => { if (++reads === 1) throw new Error("native active unavailable"); return active() }
    const ack = (await f.send()).nativeAcknowledgement
    if (ack.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
    assert.ok(f.calls.some(call => call.kind === "interrupt" && call.sessionID === "ses_coordinator"))
    assert.equal(ack.descendants?.complete, false)
  })
}

test("the family deadline also bounds a wide level and a hung native interrupt", { timeout: 10_000 }, async () => {
  const f = fixture("pause")
  const root = await f.client.session.get({ sessionID: "ses_coordinator" })
  for (const id of [...f.native.keys()]) if (id !== root.id) { f.native.delete(id); f.running.delete(id) }
  for (let index = 0; index < 40; index++) {
    const id = `ses_wide_${index}`
    f.native.set(id, { id, parentID: "ses_coordinator", projectID: "project", location: { directory: "/repo" } })
    f.running.add(id)
  }
  let started = 0
  f.client.session.interrupt = (async ({ sessionID }: any, { signal }: { signal: AbortSignal }) => {
    started++
    if (sessionID === "ses_wide_0") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    await new Promise(resolve => setTimeout(resolve, 100))
    f.running.delete(sessionID)
    return { interrupted: true }
  }) as never
  const begin = Date.now()
  const { descendants } = await interruptNativeMissionFamily({ client: f.client as never, root, action: "pause", signal: new AbortController().signal,
    current: () => {}, checkpoint: async () => {}, deadline: Date.now() + 300 })
  assert.ok(Date.now() - begin < 2_000, `bounded by the deadline: ${Date.now() - begin} ms`)
  assert.ok(started < 40, `workers stopped picking new sessions within the level: ${started}`)
  assert.equal(descendants.complete, false)
})

test("the control family reader is cycle-safe and reports an exhausted budget", async () => {
  const f = fixture("pause")
  const root = await f.client.session.get({ sessionID: "ses_coordinator" })
  const full = await readNativeControlFamily(f.client as never, root, new AbortController().signal)
  assert.equal(full.members.size, 40)
  assert.equal(full.complete, true)
  const capped = await readNativeControlFamily(f.client as never, root, new AbortController().signal, { maxSessions: 10 })
  assert.equal(capped.members.size, 10)
  assert.equal(capped.complete, false)
  // A cycle (child listed under its own descendant) is skipped, never looped.
  const list = f.client.session.list
  f.client.session.list = async (input: any) => input.parentID === "ses_coordinator_0_0_0"
    ? { data: [{ ...root, parentID: "ses_coordinator_0_0_0" }], cursor: { next: null } } : list(input)
  const cyclic = await readNativeControlFamily(f.client as never, root, new AbortController().signal)
  assert.equal(cyclic.members.size, 40)
  assert.equal(cyclic.complete, false)
})
