import { createSignal } from "solid-js"
import { captureBackendOperation } from "../lib/backend-operation"
import { getRootClient } from "./opencode-client"
import { pluginControlsCache } from "./plugin-controls"
import type { PluginControlLocation } from "../../../server/src/api-types"
import { requestLocationOptions, toRequestLocation } from "./request-locations"

const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
const key = (instanceId: string, target: string) => JSON.stringify([instanceId, target])
export const isPluginPackagePending = (instanceId: string, target: string) => pending().has(key(instanceId, target))

// Native updates are serialized by package target and affect the daemon's shared
// package cache. Keep admission beyond component lifetimes; never replay writes.
export async function runPluginPackageAction(instanceId: string, location: PluginControlLocation, target: string, action: "check" | "update") {
  const identity = key(instanceId, target)
  const operation = captureBackendOperation(instanceId)
  operation.signal.throwIfAborted()
  if (pending().has(identity)) return
  setPending(previous => new Set(previous).add(identity))
  try {
    operation.signal.throwIfAborted()
    const client = getRootClient(instanceId), options = requestLocationOptions(location)
    const scoped = toRequestLocation(location)
    if (action === "check") await client.plugin.check({ location: scoped, target }, options)
    else await client.plugin.update({ location: scoped, targets: [target] }, options)
  } finally {
    setPending(previous => { const next = new Set(previous); next.delete(identity); return next })
    if (operation.current()) pluginControlsCache.invalidateInstance(instanceId)
  }
}
