import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { OpenCodeClient, PermissionReplyInput } from "@opencode-ai/client"
import { sdkManager } from "../lib/sdk-manager"
import type { Instance } from "../types/instance"
import {
  addInstance,
  addPermissionToQueue,
  clearPermissionQueue,
  getPermissionQueue,
  hasRepliedPermission,
  markPermissionReplied,
  reconcilePendingRequestLiveness,
  removeInstance,
  sendPermissionResponse,
  syncPendingRequests,
  updateInstance,
} from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { setSessions } from "./session-state"

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
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
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

test("pending request sync cannot erase newer SSE mutations", async () => {
  const newPermission = {
    id: "new-permission", sessionID: "session", action: "edit", resources: ["*"], metadata: {},
  }
  let resolvePermissions!: (value: { location: never; data: never[] }) => void
  let permissionCalls = 0
  const client = {
    permission: { request: { list: () => ++permissionCalls === 1
      ? new Promise((resolve) => { resolvePermissions = resolve })
      : Promise.resolve({ location: {} as never, data: [newPermission] }) } },
    form: { request: { list: async () => ({ location: {} as never, data: [] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("pending-request-race", client)
  setSessions((previous) => new Map(previous).set("pending-request-race", new Map([["session", {
    id: "session", location: { directory: "/workspace" },
  } as any]])))
  addPermissionToQueue("pending-request-race", { id: "stale-permission", sessionID: "session", action: "edit", resources: [] })

  const sync = syncPendingRequests("pending-request-race")
  assert.equal(syncPendingRequests("pending-request-race"), sync)
  await new Promise<void>((resolve) => setImmediate(resolve))
  updateInstance("pending-request-race", { pid: 2 })
  addPermissionToQueue("pending-request-race", newPermission)
  resolvePermissions({ location: {} as never, data: [] })

  await sync
  assert.deepEqual(getPermissionQueue("pending-request-race").map(({ id }) => id), ["new-permission"])
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
    form: { request: {
      list: async (input: { location?: unknown }) => {
        locations.push(input.location)
        return { location: {} as never, data: [] }
      },
    } },
  } as unknown as OpenCodeClient
  addTestInstance("native-pending-api", client)
  setSessions((previous) => {
    const next = new Map(previous)
    next.set("native-pending-api", new Map([["session", {
      id: "session", location: { directory: "/worktree" },
    } as any]]))
    return next
  })

  await syncPendingRequests("native-pending-api")

  assert.deepEqual(locations, [
    { directory: "/workspace" }, { directory: "/worktree" },
    { directory: "/workspace" }, { directory: "/worktree" },
  ])
  assert.deepEqual(getPermissionQueue("native-pending-api").map(({ id }) => id), ["permission"])
})

test("liveness recovers a missed permission with an idle session and empty queue", async () => {
  const client = {
    permission: { request: {
      list: async ({ location }: { location: { directory?: string } }) => {
        return { location, data: location.directory === "/workspace" ? [{
          id: "missed", sessionID: "session", action: "edit", resources: ["*"], metadata: {},
        }] : [] }
      },
    } },
    form: { request: { list: async ({ location }: { location: unknown }) => ({ location, data: [] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("missed-permission", client)

  await reconcilePendingRequestLiveness("missed-permission")

  assert.deepEqual(getPermissionQueue("missed-permission").map(({ id }) => id), ["missed"])
})

test("pending sync removes a stale permission after its session disappears", async () => {
  const client = {
    permission: { request: { list: async ({ location }: { location: unknown }) => ({ location, data: [] }) } },
    form: { request: { list: async ({ location }: { location: unknown }) => ({ location, data: [] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("deleted-permission-session", client)
  addPermissionToQueue("deleted-permission-session", {
    id: "stale", sessionID: "deleted", action: "edit", resources: ["*"], metadata: {},
  }, "/workspace")

  await syncPendingRequests("deleted-permission-session")

  assert.deepEqual(getPermissionQueue("deleted-permission-session"), [])
})

test("partial pending scans preserve permission reply tombstones", async () => {
  const location = { directory: "/worktree" }
  const client = {
    permission: { request: { list: async ({ location: requested }: { location: { directory?: string } }) => {
      if (requested.directory === "/workspace") throw new Error("root unavailable")
      return { location, data: [] }
    } } },
    form: { request: { list: async ({ location: requested }: { location: unknown }) => ({ location: requested, data: [] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("partial-permission-scan", client)
  setSessions((previous) => new Map(previous).set("partial-permission-scan", new Map([["session", {
    id: "session", location,
  } as any]])))
  markPermissionReplied("partial-permission-scan", "answered")

  await assert.rejects(syncPendingRequests("partial-permission-scan"))

  assert.equal(hasRepliedPermission("partial-permission-scan", "answered"), true)
})

test("pending authority normalizes Windows directory keys", async () => {
  const location = { directory: "c:/repo" }
  const client = {
    permission: { request: { list: async () => ({ location, data: [] }) } },
    form: { request: { list: async () => ({ location, data: [] }) } },
  } as unknown as OpenCodeClient
  addTestInstance("normalized-permission-location", client)
  addPermissionToQueue("normalized-permission-location", {
    id: "stale", sessionID: "deleted", action: "edit", resources: ["*"], metadata: {},
  }, "C:\\Repo\\")

  await syncPendingRequests("normalized-permission-location")

  assert.deepEqual(getPermissionQueue("normalized-permission-location"), [])
})

test("cancelling a bounded pending scan does not launch queued locations", async () => {
  let calls = 0
  const list = (_input: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    calls++
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
  })
  const client = {
    permission: { request: { list } },
    form: { request: { list } },
  } as unknown as OpenCodeClient
  const instanceId = "cancelled-bounded-scan"
  addTestInstance(instanceId, client)
  setSessions((previous) => new Map(previous).set(instanceId, new Map(Array.from({ length: 10 }, (_, index) => [
    `session-${index}`,
    { id: `session-${index}`, location: { directory: `/workspace-${index}` } } as any,
  ]))))

  const sync = syncPendingRequests(instanceId)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 8)
  removeInstance(instanceId)
  await sync
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(calls, 8)
})
