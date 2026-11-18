import type { OpenCodeClient } from "@opencode/client"
import { setTimeout as delay } from "node:timers/promises"
import { locationRequestOptions } from "./compatibility/location"

/** Prepare only a caller-authorized Location. The caller owns the deadline and
 * lifetime; functional RPCs (including writes) are dispatched separately, once. */
export async function awaitNativePlugin(
  client: OpenCodeClient, pluginID: string, location: { directory: string },
  signal: AbortSignal, assertCurrent: () => void = () => {},
): Promise<void> {
  const current = () => { signal.throwIfAborted(); assertCurrent() }
  while (true) {
    current()
    const catalogue = await client.plugin.list({ location }, { ...locationRequestOptions(location), signal })
      .catch(error => { current(); throw error })
    current()
    if (catalogue.location.directory !== location.directory) throw new Error("Native plugin Location changed")
    const plugin = catalogue.data.find(item => item.id === pluginID)
    if (plugin?.state.status === "active") return
    if (plugin?.state.status === "failed") throw new Error("Native plugin unavailable: activation failed")
    await delay(50, undefined, { signal })
  }
}
