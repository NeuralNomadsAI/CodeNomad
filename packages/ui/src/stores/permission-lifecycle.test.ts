import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { sdkManager } from "../lib/sdk-manager"
import type { Instance } from "../types/instance"
import {
  addInstance,
  clearPermissionQueue,
  getPermissionQueue,
  sendPermissionResponse,
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
})

test("orphan permission.updated does not create a pending permission", () => {
  const client = {} as OpencodeClient
  addTestInstance("permission-orphan-update", client)

  handlePermissionUpdated("permission-orphan-update", {
    type: "permission.updated",
    properties: { id: "permission", sessionID: "session", patterns: ["C:/work"] },
  })

  assert.deepEqual(getPermissionQueue("permission-orphan-update"), [])
})
