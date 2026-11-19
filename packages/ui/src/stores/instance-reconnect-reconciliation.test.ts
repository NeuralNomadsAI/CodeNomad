import assert from "node:assert/strict"
import { it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import { serverEvents } from "../lib/server-events.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

const instanceId = "reconnect-reconciliation"
const session: Session = {
  id: "s", instanceId, parentId: null, title: "s", agent: "build", model: { providerId: "provider", modelId: "model" },
  status: "working", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
  version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}

it("a reconnect pulse repairs the transcript even when another reconciliation read fails, and retries the pass", async () => {
  const originalFetchWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] }) as any
  let reply = "Before the gap"
  let reads = 0
  const client: any = {
    session: {
      active: async () => ({ s: {} }),
      // The session list is the prerequisite that keeps failing.
      list: async () => { throw new Error("session list unavailable") },
    },
    message: {
      list: async () => {
        reads += 1
        return { data: [{ id: "msg_a", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
          content: [{ type: "text", text: reply }], time: { created: 2, completed: 3 } }], cursor: {} }
      },
    },
  }
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions((previous) => new Map(previous).set(instanceId, new Map([["s", session]])))
  setActiveSession(instanceId, "s")
  const text = () => Object.values(messageStoreBus.getOrCreate(instanceId).getMessage("msg_a")?.parts ?? {})
    .map((part: any) => String(part.data?.text ?? "")).join("")
  const until = async (check: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  try {
    await loadMessages(instanceId, "s")
    assert.equal(text(), "Before the gap")

    // The reply finished while routing failed upstream: the relay pulses this
    // instance's status while the browser stream itself stays connected.
    reply = "Missed reply"
    ;(serverEvents as any).dispatchBatch([
      { type: "instance.eventStatus", instanceId, status: "error", reason: "event routing failed", generation: 1 },
      { type: "instance.eventStatus", instanceId, status: "connected", generation: 1 },
    ])
    await until(() => text() === "Missed reply", 1000)
    assert.equal(text(), "Missed reply", "a failed prerequisite must not skip the transcript repair")
    const afterFirstPass = reads

    await until(() => reads > afterFirstPass, 3000)
    assert.ok(reads > afterFirstPass, "a failed reconciliation is retried")
  } finally {
    serverApi.fetchWorktrees = originalFetchWorktrees
    destroyOpenCodeData(instanceId)
    messageStoreBus.unregisterInstance(instanceId)
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
