import assert from "node:assert/strict"
import test from "node:test"

import { parseDelegateInput, parseInspectInput, parseReportInput, setupMissionsPlugin } from "./missions-plugin"

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
})

test("registers three tools, typed snapshot RPC, and role context", async () => {
  const values = new Map<string, unknown>()
  const tools: Array<{ name: string; execute(input: unknown, context: any): Promise<{ content: string }> }> = []
  let contextHook: ((event: { sessionID: string; system: Array<{ type: "text"; text: string }>; tools: Record<string, unknown> }) => Promise<void>) | undefined
  let snapshotHandler: (() => Promise<unknown>) | undefined
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
      register: async (_definition: unknown, handlers: { snapshot(): Promise<unknown> }) => {
        snapshotHandler = handlers.snapshot
        return { ...registration(), events: { emit: async (...event: unknown[]) => { emitted.push(event) } } }
      },
    },
  } as never)

  assert.deepEqual(tools.map((tool) => tool.name), ["inspect", "delegate", "report"])
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
  await cleanup()
})
