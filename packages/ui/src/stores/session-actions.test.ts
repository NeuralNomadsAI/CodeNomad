import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import {
  abortSession,
  deleteMessagePart,
  deleteMessageTechnicalParts,
  deleteTechnicalPartGroup,
  executeCustomCommand,
  executeSessionTechnicalPartDeletion,
  planSessionTechnicalPartDeletion,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
} from "./session-actions.ts"
import { setConversationModeEnabled } from "./conversation-speech.ts"
import { getModelThinkingSelection, setModelThinkingSelection } from "./preferences"
import { sessions, setProviders, setSessions } from "./session-state.ts"
import { messageStoreBus } from "./message-v2/bus.ts"

const instanceId = "session-actions"
const sessionId = "session"
const storageMethods = {
  fetchConfigOwner: serverApi.fetchConfigOwner,
  fetchStateOwner: serverApi.fetchStateOwner,
  patchStateOwner: serverApi.patchStateOwner,
}
let testUiState: Record<string, any> = {}

before(() => {
  serverApi.fetchConfigOwner = async <T extends Record<string, any> = Record<string, any>>() => ({} as T)
  serverApi.fetchStateOwner = async <T extends Record<string, any> = Record<string, any>>() => testUiState as T
  serverApi.patchStateOwner = async <T extends Record<string, any> = Record<string, any>>(_owner: string, value: unknown) => {
    const patch = value as Record<string, any>
    testUiState = {
      ...testUiState,
      ...patch,
      ...(patch.models ? { models: { ...testUiState.models, ...patch.models } } : {}),
    }
    return testUiState as T
  }
})

after(() => {
  Object.assign(serverApi, storageMethods)
})

function seed(client: any): void {
  const session = {
    id: sessionId,
    instanceId,
    parentId: null,
    title: sessionId,
    agent: "build",
    model: { providerId: "provider", modelId: "old" },
    status: "idle",
    location: { directory: "/work" },
    time: { created: 1, updated: 1 },
  } as Session

  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(new Map([[instanceId, new Map([[sessionId, session]])]]))
  setProviders(new Map([[instanceId, [{ id: "provider", name: "Provider", models: [
    { id: "old", name: "Old", providerId: "provider", variantKeys: ["high"] },
    { id: "new", name: "New", providerId: "provider", variantKeys: ["high"] },
  ] }]]]))
}

async function selectVariant(modelId: string, variant: string): Promise<void> {
  const model = { providerId: "provider", modelId }
  setModelThinkingSelection(model, variant)
  while (getModelThinkingSelection(model) !== variant) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

afterEach(() => {
  setSessions(new Map())
  setProviders(new Map())
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
  setConversationModeEnabled(instanceId, false)
  setModelThinkingSelection({ providerId: "provider", modelId: "old" }, undefined)
  setModelThinkingSelection({ providerId: "provider", modelId: "new" }, undefined)
})

describe("voice instruction sync", () => {
  it("syncs the enabled instruction before a slash command", async () => {
    const calls: string[] = []
    let commandInput: unknown
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put") },
        remove: async () => { calls.push("remove") },
      } },
      command: async (input: unknown) => { calls.push("command"); commandInput = input },
    } })
    setConversationModeEnabled(instanceId, true)

    await executeCustomCommand(instanceId, sessionId, "review", "")

    assert.deepEqual(calls, ["put", "command"])
    assert.deepEqual(commandInput, {
      sessionID: sessionId,
      command: "review",
      text: "",
      delivery: "steer",
    })
  })

  it("removes a stale instruction before a shell command", async () => {
    const calls: string[] = []
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put") },
        remove: async () => { calls.push("remove") },
      } },
      shell: async () => { calls.push("shell") },
    } })

    await runShellCommand(instanceId, sessionId, "pwd")

    assert.deepEqual(calls, ["remove", "shell"])
  })

  it("serializes concurrent syncs so the latest mode wins remotely", async () => {
    const calls: string[] = []
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put:start"); await putGate; calls.push("put:end") },
        remove: async () => { calls.push("remove") },
      } },
      command: async () => { calls.push("command") },
      shell: async () => { calls.push("shell") },
    } })
    setConversationModeEnabled(instanceId, true)
    const first = executeCustomCommand(instanceId, sessionId, "review", "")
    await new Promise<void>((resolve) => setImmediate(resolve))
    setConversationModeEnabled(instanceId, false)
    releasePut()
    await first

    assert.deepEqual(calls, ["put:start", "put:end", "remove", "command"])
    assert.equal(calls.filter((call) => call === "remove").length, 1)
  })
})

describe("session interruption", () => {
  it("interrupts the selected session and its active descendants", async () => {
    const interrupted: string[] = []
    seed({ session: { interrupt: async ({ sessionID }: { sessionID: string }) => { interrupted.push(sessionID) } } })
    const root = sessions().get(instanceId)!.get(sessionId)!
    setSessions(new Map([[instanceId, new Map([
      [sessionId, root],
      ["child-working", { ...root, id: "child-working", parentId: sessionId, status: "working" }],
      ["grandchild-working", { ...root, id: "grandchild-working", parentId: "child-working", status: "compacting" }],
      ["child-idle", { ...root, id: "child-idle", parentId: sessionId, status: "idle" }],
    ])]]))

    await abortSession(instanceId, sessionId)

    assert.deepEqual(interrupted.sort(), ["child-working", "grandchild-working", sessionId].sort())
  })
})

describe("native message content mutation", () => {
  it("removes one terminal assistant part and projects the updated response", async () => {
    const messageId = "assistant-message"
    const content = [
      { type: "reasoning", text: "thinking", time: { created: 1, completed: 2 } },
      {
        type: "tool",
        id: "tool-1",
        name: "bash",
        state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
        time: { created: 2, completed: 3 },
      },
      { type: "text", text: "done" },
    ]
    let updateInput: any
    seed({ session: {
      message: async () => ({
        id: messageId,
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "old" },
        time: { created: 1, completed: 3 },
        content,
      }),
      messageUpdate: async (input: any) => {
        updateInput = input
        return {
          id: messageId,
          type: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "old" },
          time: { created: 1, completed: 3 },
          content: input.content,
        }
      },
    } })
    const store = messageStoreBus.getOrCreate(instanceId)
    store.upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "error",
      parts: [
        { id: `${messageId}-reasoning-0`, type: "reasoning", text: "thinking" },
        { id: "tool-1", type: "tool", tool: "bash" },
        { id: `${messageId}-text-2`, type: "text", text: "done" },
      ],
    })

    await deleteMessagePart(instanceId, sessionId, messageId, "tool-1")

    assert.deepEqual(updateInput, {
      sessionID: sessionId,
      messageID: messageId,
      content: [content[0], content[2]],
    })
    assert.equal(store.getMessage(messageId)?.parts["tool-1"], undefined)
    assert.deepEqual(store.getMessage(messageId)?.partIds, [
      `${messageId}-reasoning-0`,
      `${messageId}-text-1`,
    ])
  })

  it("removes a selected range without touching tools after the response", async () => {
    const messageId = "assistant-range"
    const content = [
      { type: "reasoning", text: "before", time: { created: 1, completed: 2 } },
      { type: "tool", id: "tool-before", name: "bash", state: { status: "completed", input: {}, content: [] }, time: { created: 2, completed: 3 } },
      { type: "text", text: "response" },
      { type: "tool", id: "tool-after", name: "bash", state: { status: "completed", input: {}, content: [] }, time: { created: 4, completed: 5 } },
      { type: "reasoning", text: "after", time: { created: 5, completed: 6 } },
    ]
    let updateInput: any
    seed({ session: {
      message: async () => ({ id: messageId, type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, time: { created: 1, completed: 6 }, content }),
      messageUpdate: async (input: any) => {
        updateInput = input
        return { id: messageId, type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, time: { created: 1, completed: 6 }, content: input.content }
      },
    } })
    messageStoreBus.getOrCreate(instanceId).upsertMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      status: "complete",
      parts: [
        { id: `${messageId}-reasoning-0`, type: "reasoning", text: "before" },
        { id: "tool-before", type: "tool", tool: "bash" },
        { id: `${messageId}-text-2`, type: "text", text: "response" },
        { id: "tool-after", type: "tool", tool: "bash" },
        { id: `${messageId}-reasoning-4`, type: "reasoning", text: "after" },
      ],
    })

    await deleteMessageTechnicalParts(instanceId, sessionId, messageId, [`${messageId}-reasoning-0`, "tool-before"])

    assert.deepEqual(updateInput.content, [content[2], content[3], content[4]])
    assert.ok(messageStoreBus.getOrCreate(instanceId).getMessage(messageId)?.parts["tool-after"])
  })

  it("removes a technical group with one update per message", async () => {
    const messages = new Map<string, any>([
      ["assistant-1", { id: "assistant-1", type: "assistant", time: { created: 1, completed: 2 }, content: [
        { type: "tool", id: "shell-1", name: "bash", state: { status: "completed", input: {}, content: [] }, time: { created: 1, completed: 2 } },
        { type: "text", text: "first" },
      ] }],
      ["assistant-2", { id: "assistant-2", type: "assistant", time: { created: 3, completed: 4 }, content: [
        { type: "tool", id: "shell-2", name: "bash", state: { status: "completed", input: {}, content: [] }, time: { created: 3, completed: 4 } },
        { type: "text", text: "second" },
      ] }],
    ])
    const updates: any[] = []
    seed({ session: {
      message: async ({ messageID }: { messageID: string }) => messages.get(messageID),
      messageUpdate: async (input: any) => {
        updates.push(input)
        return { ...messages.get(input.messageID), content: input.content }
      },
    } })
    const store = messageStoreBus.getOrCreate(instanceId)
    for (const [messageId, message] of messages) {
      store.upsertMessage({
        id: messageId,
        sessionId,
        role: "assistant",
        status: "complete",
        parts: [{ id: message.content[0].id, type: "tool", tool: "bash" }, { id: `${messageId}-text-1`, type: "text", text: message.content[1].text }],
      })
    }

    await deleteTechnicalPartGroup(instanceId, sessionId, [
      { messageId: "assistant-1", partId: "shell-1" },
      { messageId: "assistant-2", partId: "shell-2" },
    ])

    assert.deepEqual(updates.map((update) => [update.messageID, update.content]), [
      ["assistant-1", [{ type: "text", text: "first" }]],
      ["assistant-2", [{ type: "text", text: "second" }]],
    ])
  })

  it("plans every completed response and re-reads it before session cleanup", async () => {
    const text = (value: string) => ({ type: "text", text: value })
    const reasoning = { type: "reasoning", text: "thinking", time: { created: 1, completed: 2 } }
    const tool = {
      type: "tool",
      id: "tool-1",
      name: "bash",
      state: { status: "completed", input: {}, content: [text("ok")] },
      time: { created: 2, completed: 3 },
    }
    const messages = new Map<string, any>([
      ["assistant-1", { id: "assistant-1", type: "assistant", time: { created: 1, completed: 3 }, content: [reasoning, text("first")] }],
      ["assistant-active", { id: "assistant-active", type: "assistant", time: { created: 4 }, content: [tool] }],
      ["assistant-2", { id: "assistant-2", type: "assistant", time: { created: 5, completed: 7 }, content: [tool, text("second")] }],
    ])
    const updates: any[] = []
    let page = 0
    seed({
      message: { list: async () => {
        page += 1
        return page === 1
          ? { data: [messages.get("assistant-1"), messages.get("assistant-active")], cursor: { next: "page-2" } }
          : { data: [messages.get("assistant-2")], cursor: {} }
      } },
      session: {
        message: async ({ messageID }: { messageID: string }) => messages.get(messageID),
        messageUpdate: async (input: any) => {
          updates.push(input)
          return { ...messages.get(input.messageID), content: input.content }
        },
      },
    })

    const plan = await planSessionTechnicalPartDeletion(instanceId, sessionId)
    messages.get("assistant-1").content = [reasoning, text("updated")]
    const failed = await executeSessionTechnicalPartDeletion(plan)

    assert.deepEqual(plan, {
      instanceId,
      sessionId,
      toolCount: 1,
      reasoningCount: 1,
      messageIds: ["assistant-1", "assistant-2"],
    })
    assert.equal(failed, 0)
    assert.deepEqual(updates, [
      { sessionID: sessionId, messageID: "assistant-1", content: [text("updated")] },
      { sessionID: sessionId, messageID: "assistant-2", content: [text("second")] },
    ])
    const store = messageStoreBus.getOrCreate(instanceId)
    assert.deepEqual(store.getMessage("assistant-1")?.partIds, ["assistant-1-text-0"])
    assert.deepEqual(store.getMessage("assistant-2")?.partIds, ["assistant-2-text-0"])
  })
})

describe("native session selection persistence", () => {
  it("switches the native agent", async () => {
    const inputs: unknown[] = []
    seed({ session: {
      switchAgent: async (value: unknown) => { inputs.push(value) },
      switchModel: async (value: unknown) => { inputs.push(value) },
    } })

    await updateSessionAgent(instanceId, sessionId, "plan")

    assert.deepEqual(inputs, [
      { sessionID: sessionId, agent: "plan" },
      { sessionID: sessionId, model: { providerID: "provider", id: "old" } },
    ])
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.agent, "plan")
  })

  it("switches the native model with ModelRef field names", async () => {
    let input: unknown
    seed({ session: { switchModel: async (value: unknown) => { input = value } } })

    await updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" })

    assert.deepEqual(input, {
      sessionID: sessionId,
      model: { providerID: "provider", id: "new" },
    })
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "new" })
  })

  it("persists the selected variant for model and agent-driven model switches", async () => {
    const inputs: unknown[] = []
    seed({ session: {
      switchAgent: async () => {},
      switchModel: async (value: unknown) => { inputs.push(value) },
    } })
    await selectVariant("new", "high")
    await selectVariant("old", "high")

    await updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" })
    await updateSessionAgent(instanceId, sessionId, "plan")

    assert.deepEqual(inputs, [
      { sessionID: sessionId, model: { providerID: "provider", id: "new", variant: "high" } },
      { sessionID: sessionId, model: { providerID: "provider", id: "old", variant: "high" } },
    ])
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "old" })
  })

  it("rolls back local selections when native switching fails", async () => {
    const error = new Error("switch failed")
    seed({ session: {
      switchAgent: async () => { throw error },
      switchModel: async () => { throw error },
    } })

    await assert.rejects(updateSessionAgent(instanceId, sessionId, "plan"), error)
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.agent, "build")

    await assert.rejects(updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" }), error)
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "old" })
  })
})

describe("native prompt serialization", () => {
  it("sends agent attachments with mention offsets and the selected model variant", async () => {
    const calls: Array<{ type: string; input: any }> = []
    seed({ session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      switchAgent: async (input: unknown) => { calls.push({ type: "agent", input }) },
      switchModel: async (input: unknown) => { calls.push({ type: "model", input }) },
      prompt: async (input: unknown) => { calls.push({ type: "prompt", input }) },
    } })
    await selectVariant("old", "high")
    setProviders(new Map([[instanceId, [{ id: "provider", name: "Provider", models: [
      { id: "old", name: "Old", providerId: "provider", variantKeys: ["high"] },
    ] }]]]))

    await sendMessage(instanceId, sessionId, "Ask @reviewer now", [{
      id: "agent-attachment",
      type: "agent",
      display: "@reviewer",
      url: "",
      filename: "reviewer",
      mediaType: "text/plain",
      source: { type: "agent", name: "reviewer" },
    }])

    assert.deepEqual(calls[0], {
      type: "agent",
      input: { sessionID: sessionId, agent: "build" },
    })
    assert.deepEqual(calls[1], {
      type: "model",
      input: { sessionID: sessionId, model: { providerID: "provider", id: "old", variant: "high" } },
    })
    assert.deepEqual(calls[2]?.input.agents, [{
      name: "reviewer",
      mention: { start: 4, end: 13, text: "@reviewer" },
    }])
  })

  it("replaces a queued prompt only after admitting its edited replacement", async () => {
    const calls: Array<{ type: string; input: any }> = []
    seed({ session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      switchAgent: async () => { calls.push({ type: "agent", input: undefined }) },
      switchModel: async () => { calls.push({ type: "model", input: undefined }) },
      prompt: async (input: any) => { calls.push({ type: "prompt", input }); return { id: input.id } },
      inbox: { cancel: async (input: unknown) => { calls.push({ type: "cancel", input }) } },
    } })

    await sendMessage(instanceId, sessionId, "edited @reviewer", [], {
      delivery: "queue",
      replace: {
        id: "queued-1",
        sessionID: sessionId,
        timeCreated: 1,
        type: "user",
        delivery: "queue",
        payload: {
          text: "original @reviewer\n\nhidden note",
          metadata: { displayText: "original @reviewer" },
          agents: [{ name: "reviewer", mention: { start: 9, end: 18, text: "@reviewer" } }],
        },
      },
    })

    assert.equal(calls[0]?.type, "prompt")
    assert.equal(calls[0]?.input.text, "edited @reviewer\n\nhidden note")
    assert.equal(calls[0]?.input.delivery, "queue")
    assert.equal(calls[0]?.input.resume, false)
    assert.deepEqual(calls[0]?.input.agents, [{ name: "reviewer", mention: { start: 7, end: 16, text: "@reviewer" } }])
    assert.deepEqual(calls[1], { type: "cancel", input: { sessionID: sessionId, inboxID: "queued-1" } })
    assert.equal(calls.some((call) => call.type === "agent" || call.type === "model"), false)
  })
})
