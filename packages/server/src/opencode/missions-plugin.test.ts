import assert from "node:assert/strict"
import test from "node:test"

import { parseDelegateInput, parseInspectInput, parseReportInput, parseReviseInput, setupMissionsPlugin } from "./missions-plugin"

test("validates the compact mission tool contracts", () => {
  assert.deepEqual(parseInspectInput({ start: { objective: "Fix it", template: "pocock-fix-bug" } }), {
    start: { objective: "Fix it", template: "pocock-fix-bug", notes: undefined },
    missionID: undefined,
  })
  assert.deepEqual(parseDelegateInput({ taskKey: "review-spec", title: "Review", brief: "Check spec", role: "review-spec" }), {
    missionID: undefined,
    taskKey: "review-spec",
    title: "Review",
    brief: "Check spec",
    role: "review-spec",
    blockedBy: [],
    targetSessionID: undefined,
    delivery: "queue",
  })
  assert.deepEqual(parseReportInput({ outcome: "completed", summary: "Green" }), {
    missionID: undefined,
    taskKey: undefined,
    outcome: "completed",
    summary: "Green",
    evidence: [],
    next: [],
    artifact: undefined,
    final: false,
  })
  assert.throws(() => parseDelegateInput({ taskKey: "Bad Key", title: "x", brief: "x", role: "x" }), /lowercase/)
  assert.throws(() => parseInspectInput({ start: { objective: "x", template: "pipeline" } }), /unsupported/)
  assert.deepEqual(parseReviseInput({ expectedRevision: 1, requestID: "revise-1", reason: "New facts", notes: "", retireTasks: [] }), {
    missionID: undefined, expectedRevision: 1, requestID: "revise-1", reason: "New facts", objective: undefined, notes: "",
    retireTasks: [], addTasks: [], dependencyUpdates: [],
  })
  assert.throws(() => parseReviseInput({ expectedRevision: 1, requestID: "bad", reason: "Missing contract", addTasks: [{ taskKey: "bad" }] }), /title/)
})

test("registers four tools, typed snapshot RPC, and role context", async () => {
  const values = new Map<string, unknown>()
  const tools: Array<{ name: string; execute(input: unknown, context: any): Promise<{ content: string }> }> = []
  let contextHook: ((event: { sessionID: string; system: Array<{ type: "text"; text: string }>; tools: Record<string, unknown> }) => Promise<void>) | undefined
  let snapshotHandler: (() => Promise<unknown>) | undefined
  let createHandler: ((input: unknown) => Promise<unknown>) | undefined
  let deleteHandler: ((input: unknown, context: any) => Promise<unknown>) | undefined
  const emitted: unknown[] = []
  const registration = () => ({ dispose: async () => {} })
  const cleanup = await setupMissionsPlugin({
    location: { directory: "/repo", project: { id: "project-1", canonical: "/repo" } },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, projectID: "project-1", title: "Coordinator", location: { directory: "/repo" },
      }),
      create: async () => { throw new Error("not used") },
      prompt: async () => {},
      synthetic: async () => {},
      hook: async (_name: "context", callback: typeof contextHook) => {
        contextHook = callback
        return registration()
      },
    },
    tool: {
      transform: async (callback: (draft: any) => void) => {
        callback({ namespace: () => {}, add: (tool: any) => tools.push(tool) })
        return registration()
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: { snapshot(): Promise<unknown>; create(input: unknown): Promise<unknown>; update(input: unknown): Promise<unknown>; delete(input: unknown, context: any): Promise<unknown> }) => {
        snapshotHandler = handlers.snapshot
        createHandler = handlers.create
        deleteHandler = handlers.delete
        return { ...registration(), events: { emit: async (...event: unknown[]) => { emitted.push(event) } } }
      },
    },
  } as never)

  assert.deepEqual(tools.map((tool) => tool.name), ["inspect", "delegate", "revise", "report"])
  const inspect = tools.find((tool) => tool.name === "inspect")!
  await inspect.execute({ start: { objective: "Coordinate", template: "custom" } }, {
    sessionID: "ses_coordinator", messageID: "msg_1", id: "call_1", progress: async () => {},
  })
  const snapshot = await snapshotHandler!() as { missions: Array<Record<string, unknown>> }
  assert.equal(snapshot.missions.length, 1)
  assert.equal("notes" in snapshot.missions[0], false)
  assert.equal(emitted.length, 1)

  const event = { sessionID: "ses_coordinator", system: [] as Array<{ type: "text"; text: string }>, tools: { mission_delegate: {} } }
  await contextHook!(event)
  assert.equal(event.system[0]?.type, "text")
  assert.match(event.system[0]?.text ?? "", /Only this coordinator session/)
  assert.ok(event.tools.mission_delegate)
  const revise = tools.find((tool) => tool.name === "revise")!
  await revise.execute({ expectedRevision: 1, requestID: "revise-from-tool", reason: "User clarified", objective: "Revised objective" }, {
    sessionID: "ses_coordinator", messageID: "msg_2", id: "call_2", progress: async () => {},
  })
  const revised = await snapshotHandler!() as { missions: Array<{ objective: string; history: Array<{ reason: string }> }> }
  assert.equal(revised.missions[0]?.objective, "Revised objective")
  assert.equal(revised.missions[0]?.history[0]?.reason, "User clarified")
  assert.equal(emitted.length, 2)
  const mutationContext = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const deleteInput = { missionID: snapshot.missions[0].id, expectedRevision: 2, requestID: "delete-from-rpc" }
  const invalid = await deleteHandler!({ ...deleteInput, deleteManagedSessions: "true" }, mutationContext) as { data: { code: string } }
  assert.equal(invalid.data.code, "invalid-delete-option")
  assert.deepEqual(await deleteHandler!({ ...deleteInput, deleteManagedSessions: true }, mutationContext), { deleted: true })
  const deleted = [...values.values()].find((value: any) => value.type === "mission.deleted") as { deleteManagedSessions: boolean; cleanupTargets: unknown[] }
  assert.equal(deleted.deleteManagedSessions, true)
  assert.deepEqual(deleted.cleanupTargets, [])
  const conflicting = await deleteHandler!(deleteInput, mutationContext) as { data: { code: string } }
  assert.equal(conflicting.data.code, "request-conflict")
  await cleanup()
  await assert.rejects(createHandler!({ requestID: "post-dispose", objective: "No", template: "custom" }), /no longer available/)
  await assert.rejects(revise.execute({}, { sessionID: "ses_coordinator", id: "stale-revise" }), /no longer available/)
  await assert.rejects(inspect.execute({}, {
    sessionID: "ses_coordinator", id: "stale-tool", progress: async () => {},
  }), /no longer available/)
})

test("failed presence activation disposes partial registrations and fences captured tools", async () => {
  const disposed: string[] = []
  const captured: Array<{ execute(input: unknown, context: unknown): Promise<unknown> }> = []
  await assert.rejects(setupMissionsPlugin({
    location: { directory: "/repo", project: { id: "project-1", canonical: "/repo" } },
    storage: {},
    session: { hook: async () => { throw new Error("hook failed") } },
    rpc: { register: async () => ({ dispose: async () => { disposed.push("rpc") } }) },
    tool: { transform: async (callback: (draft: unknown) => void) => {
      callback({ namespace: () => {}, add: (tool: typeof captured[number]) => captured.push(tool) })
      return { dispose: async () => { disposed.push("tools") } }
    } },
  } as never), /hook failed/)
  assert.deepEqual(disposed.sort(), ["rpc", "tools"])
  await assert.rejects(captured[0].execute({}, {}), /no longer available/)
})
