import assert from "node:assert/strict"
import { test } from "node:test"
import type { Logger } from "../logger"
import { WorkspaceCapabilityError } from "../opencode/servers/capabilities"
import { PermissionReceipts } from "../permissions/receipts"
import type { PermissionReceiptStore } from "../permissions/receipt-store"
import { observeProviderQuotaFailures } from "../provider-accounts/quota-observer"
import type { WorkspaceManager } from "../workspaces/manager"
import { nativeEventConnections, type ServiceConnection } from "../workspaces/opencode-service"
import { EventBus } from "./bus"

test("explicit events/statuses cannot wake receipt or quota readers, or consume local bare-ID deduplication", async () => {
  const effects: string[] = [], bus = new EventBus()
  const connection = {
    endpoint: { url: "https://a.example" },
    client: { config: { get: async () => { effects.push("config"); return [] } } },
  } as unknown as ServiceConnection
  const manager = {
    get: () => ({ path: "/same" }),
    requireWorkspaceCapability(_id: string, capability: "historyEnrichment" | "pendingRecovery") {
      throw new WorkspaceCapabilityError(capability, { code: "deferred" })
    },
    getSharedServiceConnection: async () => { effects.push("acquire"); return connection },
    getServiceWslDistro: () => { effects.push("wsl"); return undefined },
    getServicePathStyle: () => { effects.push("path"); return "posix" },
  } as unknown as WorkspaceManager
  const receipts = new PermissionReceipts({} as PermissionReceiptStore, manager, bus, { error() {} } as unknown as Logger)
  const off = observeProviderQuotaFailures(bus, {
    observeSwitch: () => { effects.push("switch") },
    observeStepStart: () => { effects.push("step") },
    switchWatermark: () => { effects.push("watermark"); return 0 },
    markQuotaFailure: async () => { effects.push("quota"); return true },
  })
  receipts.start()
  try {
    for (const serverId of ["A", "B"]) {
      const source = { serverId, generation: 1 }
      bus.publish({ type: "instance.eventStatus", instanceId: serverId, status: "connected", generation: 1, source })
      for (const type of ["permission.asked", "session.deleted", "credential.switched", "session.step.started", "session.execution.failed"]) {
        const event = { type, id: "same-event", created: 1, data: {
          id: "same-request", sessionID: "same-session", integrationID: "same-integration", error: { type: "provider.quota" },
        } }
        nativeEventConnections.set(event, connection)
        bus.publish({ type: "instance.event", instanceId: serverId, event, source } as never)
      }
      await assert.rejects(receipts.list(serverId, "same-session", {}), WorkspaceCapabilityError)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(effects.slice(), [])
    const localEvent = { type: "credential.switched", id: "same-event", data: { integrationID: "same-integration" } }
    nativeEventConnections.set(localEvent, connection)
    bus.publish({ type: "instance.event", instanceId: "local", event: localEvent } as never)
    assert.deepEqual(effects, ["switch"])
  } finally { off(); await receipts.stop() }
})
