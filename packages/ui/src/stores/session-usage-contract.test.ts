import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { getSessionInfo, setActiveSession, setMessagesLoaded, setSessions } from "./session-state.ts"

const model = { providerID: "fixture", id: "fixture" }

function tokens(input: number, output: number) {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

function setup(instanceId: string, sessionId: string, options: { active?: boolean; session?: Record<string, unknown> } = {}) {
  const statuses = sseManager.getStatuses
  sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
  const client = {
    session: { active: async () => ({}), get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 5 } }) },
    message: { list: async () => ({ data: [], cursor: {} }) },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
    id: sessionId, instanceId, title: "Fixture", parentId: null, location: { directory: "/fixture" },
    status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
    ...options.session,
  } as any]])))
  if (options.active !== false) setActiveSession(instanceId, sessionId)
  const emit = (type: string, data: Record<string, unknown>, created: number) => {
    const event = { id: `evt_${created}`, type, created, data, location: { directory: "/fixture" } } as OpenCodeEvent
    handleInstanceInvalidation(instanceId, event)
    handleNativeSessionEvent(instanceId, event)
  }
  const cleanup = () => {
    sseManager.getStatuses = statuses
    destroyOpenCodeData(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
  }
  return { emit, cleanup }
}

function assertUsage(instanceId: string, sessionId: string, expected: { cost: number; input: number; output: number }) {
  const info = getSessionInfo(instanceId, sessionId)
  assert.ok(info, "session info must exist")
  assert.equal(info.cost, expected.cost)
  assert.equal(info.inputTokens, expected.input)
  assert.equal(info.outputTokens, expected.output)
}

test("a completed step on the active session refreshes the session usage totals", () => {
  const instanceId = "usage-step-ended", sessionId = "s"
  const { emit, cleanup } = setup(instanceId, sessionId)
  try {
    const base = { sessionID: sessionId, assistantMessageID: "m" }
    emit("session.step.started", { ...base, agent: "build", model, started: 1 }, 1)
    emit("session.step.ended", { ...base, finish: "stop", cost: 1, tokens: tokens(10, 5) }, 2)
    assertUsage(instanceId, sessionId, { cost: 1, input: 10, output: 5 })
  } finally { cleanup() }
})

test("a usage-only event fills the totals when no messages are loaded", () => {
  const instanceId = "usage-only", sessionId = "s"
  const { emit, cleanup } = setup(instanceId, sessionId)
  try {
    emit("session.usage.updated", { sessionID: sessionId, cost: 2.5, tokens: tokens(1200, 300) }, 1)
    assertUsage(instanceId, sessionId, { cost: 2.5, input: 1200, output: 300 })
  } finally { cleanup() }
})

test("usage events for an inactive session still update its totals", () => {
  const instanceId = "usage-inactive", sessionId = "s"
  const { emit, cleanup } = setup(instanceId, sessionId, { active: false })
  try {
    emit("session.usage.updated", { sessionID: sessionId, cost: 2.5, tokens: tokens(1200, 300) }, 1)
    assertUsage(instanceId, sessionId, { cost: 2.5, input: 1200, output: 300 })
  } finally { cleanup() }
})

test("opening an already-loaded session initializes totals from the hydrated session record", async () => {
  const instanceId = "usage-hydrated", sessionId = "s"
  const { cleanup } = setup(instanceId, sessionId, { session: { cost: 2.5, tokens: tokens(1200, 300) } })
  setMessagesLoaded(previous => new Map(previous).set(instanceId, new Set([sessionId])))
  try {
    assert.equal(getSessionInfo(instanceId, sessionId), undefined)
    await loadMessages(instanceId, sessionId)
    assertUsage(instanceId, sessionId, { cost: 2.5, input: 1200, output: 300 })
  } finally { cleanup() }
})

test("a committed revert that removes a message lowers the totals", () => {
  const instanceId = "usage-revert", sessionId = "s"
  const { emit, cleanup } = setup(instanceId, sessionId)
  try {
    for (const [id, cost, created] of [["m1", 1, 1], ["m2", 4, 3]] as const) {
      const base = { sessionID: sessionId, assistantMessageID: id }
      emit("session.step.started", { ...base, agent: "build", model, started: created }, created)
      emit("session.step.ended", { ...base, finish: "stop", cost, tokens: tokens(10 * cost, 5 * cost) }, created + 1)
    }
    assertUsage(instanceId, sessionId, { cost: 5, input: 50, output: 25 })
    emit("session.revert.committed", { sessionID: sessionId, to: "m2" }, 5)
    assertUsage(instanceId, sessionId, { cost: 1, input: 10, output: 5 })
  } finally { cleanup() }
})
