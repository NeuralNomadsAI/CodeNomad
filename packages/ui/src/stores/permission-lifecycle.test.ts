import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
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
  syncPendingRequests,
  updateInstance,
} from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { handlePermissionUpdated } from "./session-events"

const instanceIds: string[] = []
const originalCreateClient = sdkManager.createClient

function addTestInstance(id: string, client: OpencodeClient): void {
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

test("permission.updated preserves the V2 reply route", async () => {
  let legacyReplies = 0
  let v2Replies = 0
  const client = {
    permission: {
      reply: async () => { legacyReplies += 1; return { data: true } },
    },
    v2: { session: { permission: {
      reply: async () => { v2Replies += 1; return { data: true } },
    } } },
  } as unknown as OpencodeClient
  sdkManager.createClient = (() => client) as typeof sdkManager.createClient
  addTestInstance("permission-v2-source", client)

  handlePermissionUpdated("permission-v2-source", {
    type: "permission.v2.asked",
    properties: { id: "permission", sessionID: "session", action: "external_directory", resources: ["C:/work"] },
  } as never)
  handlePermissionUpdated("permission-v2-source", {
    type: "permission.updated",
    properties: { id: "permission", sessionID: "session", patterns: ["C:/work"] },
  })
  await sendPermissionResponse("permission-v2-source", "session", "permission", "always")

  assert.equal(v2Replies, 1)
  assert.equal(legacyReplies, 0)
  handlePermissionUpdated("permission-v2-source", {
    type: "permission.updated",
    properties: { id: "permission", sessionID: "session", patterns: ["C:/work"] },
  })
  assert.deepEqual(getPermissionQueue("permission-v2-source"), [])
})

test("standalone permission.updated remains a legacy permission request", async () => {
  let legacyReplies = 0
  let v2Replies = 0
  const client = {
    permission: {
      reply: async () => { legacyReplies += 1; return { data: true } },
    },
    v2: { session: { permission: {
      reply: async () => { v2Replies += 1; return { data: true } },
    } } },
  } as unknown as OpencodeClient
  sdkManager.createClient = (() => client) as typeof sdkManager.createClient
  addTestInstance("permission-legacy-update", client)

  handlePermissionUpdated("permission-legacy-update", {
    type: "permission.updated",
    properties: { id: "permission", sessionID: "session", patterns: ["C:/work"] },
  })
  assert.equal(getPermissionQueue("permission-legacy-update").length, 1)
  await sendPermissionResponse("permission-legacy-update", "session", "permission", "always")

  assert.equal(legacyReplies, 1)
  assert.equal(v2Replies, 0)
})

test("pending request sync cannot erase newer SSE mutations", async () => {
  const newPermission = {
    id: "new-permission", sessionID: "session", permission: "edit", patterns: ["*"], metadata: {},
  }
  const newQuestion = { id: "new-question", sessionID: "session", questions: [] }
  let resolvePermissions!: (value: { data: never[] }) => void
  let resolveQuestions!: (value: { data: never[] }) => void
  let permissionCalls = 0
  let questionCalls = 0
  const client = {
    permission: { list: () => ++permissionCalls === 1
      ? new Promise((resolve) => { resolvePermissions = resolve })
      : Promise.resolve({ data: [newPermission] }) },
    question: { list: () => ++questionCalls === 1
      ? new Promise((resolve) => { resolveQuestions = resolve })
      : Promise.resolve({ data: [newQuestion] }) },
    v2: {
      permission: { request: { list: async () => ({ data: { data: [] } }) } },
      question: { request: { list: async () => ({ data: { data: [] } }) } },
    },
  } as unknown as OpencodeClient
  addTestInstance("pending-request-race", client)
  addPermissionToQueue("pending-request-race", { id: "stale-permission", sessionID: "session" } as never)
  addQuestionToQueue("pending-request-race", { id: "stale-question", sessionID: "session" } as never)

  const sync = syncPendingRequests("pending-request-race")
  assert.equal(syncPendingRequests("pending-request-race"), sync)
  await new Promise<void>((resolve) => setImmediate(resolve))
  updateInstance("pending-request-race", { pid: 2 })
  addPermissionToQueue("pending-request-race", newPermission as never)
  addQuestionToQueue("pending-request-race", newQuestion as never)
  resolvePermissions({ data: [] })
  resolveQuestions({ data: [] })

  await sync
  assert.deepEqual(getPermissionQueue("pending-request-race").map(({ id }) => id), ["new-permission"])
  assert.deepEqual(getQuestionQueue("pending-request-race").map(({ id }) => id), ["new-question"])
})

test("pending request sync still loads V2 requests when legacy listing fails", async () => {
  const client = {
    permission: { list: async () => ({ error: { message: "legacy unavailable" } }) },
    question: { list: async () => ({ data: [] }) },
    v2: {
      permission: { request: { list: async () => ({ data: { data: [{
        id: "v2-permission", sessionID: "session", permission: "edit", patterns: ["*"], metadata: {},
      }] } }) } },
      question: { request: { list: async () => ({ data: { data: [] } }) } },
    },
  } as unknown as OpencodeClient
  addTestInstance("partial-pending-api", client)

  await syncPendingRequests("partial-pending-api")

  assert.deepEqual(getPermissionQueue("partial-pending-api").map(({ id }) => id), ["v2-permission"])
})
