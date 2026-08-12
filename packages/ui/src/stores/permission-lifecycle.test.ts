import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { OpenCodeClient, PermissionReplyInput, QuestionRejectInput, QuestionReplyInput } from "@opencode-ai/client"
import { sdkManager } from "../lib/sdk-manager"
import type { Instance } from "../types/instance"
import {
  addInstance,
  addPermissionToQueue,
  addQuestionToQueue,
  clearPermissionQueue,
  clearQuestionQueue,
  getPermissionQueue,
  getQuestionQueue,
  sendPermissionResponse,
  sendQuestionReject,
  sendQuestionReply,
  syncPendingRequests,
  updateInstance,
} from "./instances"
import { messageStoreBus } from "./message-v2/bus"

const instanceIds: string[] = []
const originalCreateClient = sdkManager.createClient

function addTestInstance(id: string, client: OpenCodeClient): void {
  instanceIds.push(id)
  addInstance({
    id,
    folder: "/workspace",
    port: 1,
    pid: 1,
    proxyPath: `/workspaces/${id}/instance`,
    status: "ready",
    client,
  } satisfies Instance)
}

afterEach(() => {
  for (const instanceId of instanceIds.splice(0)) {
    clearPermissionQueue(instanceId)
    clearQuestionQueue(instanceId)
    messageStoreBus.unregisterInstance(instanceId)
    sdkManager.destroyClientsForInstance(instanceId)
  }
  sdkManager.createClient = originalCreateClient
})

test("permission replies use the queued request session", async () => {
  let input: PermissionReplyInput | undefined
  const client = {
    permission: {
      reply: async (next: PermissionReplyInput) => { input = next },
    },
  } as unknown as OpenCodeClient
  sdkManager.createClient = (() => client) as typeof sdkManager.createClient
  addTestInstance("permission-reply", client)
  addPermissionToQueue("permission-reply", {
    id: "permission",
    sessionID: "queued-session",
    action: "external_directory",
    resources: ["C:/work"],
  })

  await sendPermissionResponse("permission-reply", "stale-session", "permission", "always", "trusted")

  assert.deepEqual(input, {
    sessionID: "queued-session",
    requestID: "permission",
    reply: "always",
    message: "trusted",
  })
  assert.deepEqual(getPermissionQueue("permission-reply"), [])
})

test("question replies and rejects use queued request sessions", async () => {
  const replies: QuestionReplyInput[] = []
  const rejects: QuestionRejectInput[] = []
  const client = {
    question: {
      reply: async (input: QuestionReplyInput) => { replies.push(input) },
      reject: async (input: QuestionRejectInput) => { rejects.push(input) },
    },
  } as unknown as OpenCodeClient
  sdkManager.createClient = (() => client) as typeof sdkManager.createClient
  addTestInstance("question-replies", client)
  addQuestionToQueue("question-replies", { id: "reply", sessionID: "reply-session", questions: [] })
  addQuestionToQueue("question-replies", { id: "reject", sessionID: "reject-session", questions: [] })

  await sendQuestionReply("question-replies", "stale-session", "reply", [["yes"]])
  await sendQuestionReject("question-replies", "stale-session", "reject")

  assert.deepEqual(replies, [{ sessionID: "reply-session", requestID: "reply", answers: [["yes"]] }])
  assert.deepEqual(rejects, [{ sessionID: "reject-session", requestID: "reject" }])
  assert.deepEqual(getQuestionQueue("question-replies"), [])
})

test("pending request sync cannot erase newer SSE mutations", async () => {
  const newPermission = {
    id: "new-permission", sessionID: "session", action: "edit", resources: ["*"], metadata: {},
  }
  const newQuestion = { id: "new-question", sessionID: "session", questions: [] }
  let resolvePermissions!: (value: { location: never; data: never[] }) => void
  let resolveQuestions!: (value: { location: never; data: never[] }) => void
  let permissionCalls = 0
  let questionCalls = 0
  const client = {
    permission: { request: { list: () => ++permissionCalls === 1
      ? new Promise((resolve) => { resolvePermissions = resolve })
      : Promise.resolve({ location: {} as never, data: [newPermission] }) } },
    question: { request: { list: () => ++questionCalls === 1
      ? new Promise((resolve) => { resolveQuestions = resolve })
      : Promise.resolve({ location: {} as never, data: [newQuestion] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("pending-request-race", client)
  addPermissionToQueue("pending-request-race", { id: "stale-permission", sessionID: "session", action: "edit", resources: [] })
  addQuestionToQueue("pending-request-race", { id: "stale-question", sessionID: "session", questions: [] })

  const sync = syncPendingRequests("pending-request-race")
  assert.equal(syncPendingRequests("pending-request-race"), sync)
  await new Promise<void>((resolve) => setImmediate(resolve))
  updateInstance("pending-request-race", { pid: 2 })
  addPermissionToQueue("pending-request-race", newPermission)
  addQuestionToQueue("pending-request-race", newQuestion)
  resolvePermissions({ location: {} as never, data: [] })
  resolveQuestions({ location: {} as never, data: [] })

  await sync
  assert.deepEqual(getPermissionQueue("pending-request-race").map(({ id }) => id), ["new-permission"])
  assert.deepEqual(getQuestionQueue("pending-request-race").map(({ id }) => id), ["new-question"])
})

test("pending request sync uses native global lists with an explicit directory", async () => {
  const locations: unknown[] = []
  const client = {
    permission: { request: {
      list: async (input: { location?: unknown }) => {
        locations.push(input.location)
        return { location: {} as never, data: [{
          id: "permission", sessionID: "session", action: "edit", resources: ["*"], metadata: {},
        }] }
      },
    } },
    question: { request: {
      list: async (input: { location?: unknown }) => {
        locations.push(input.location)
        return { location: {} as never, data: [{ id: "question", sessionID: "session", questions: [] }] }
      },
    } },
  } as unknown as OpenCodeClient
  addTestInstance("native-pending-api", client)

  await syncPendingRequests("native-pending-api")

  assert.deepEqual(locations, [{ directory: "/workspace" }, { directory: "/workspace" }])
  assert.deepEqual(getPermissionQueue("native-pending-api").map(({ id }) => id), ["permission"])
  assert.deepEqual(getQuestionQueue("native-pending-api").map(({ id }) => id), ["question"])
})
