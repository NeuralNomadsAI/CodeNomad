import type { PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { locationRequestOptions } from "./compatibility/location"
import { NativeMutationAdmission, type NativeMutationAuthority } from "./native-mutation-authority"
import { PluginControlsError, type PluginControls } from "./plugin-controls"
import { validatePluginSourceSpec } from "./plugin-source-document"

/** Internal package updates through the acquired, authenticated native connection. */
export class PluginPackages {
  constructor(private readonly deps: {
    controls: Pick<PluginControls, "read">
    workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation">
  }) {}

  /** Internal target derived by a future trusted catalog adapter; never expose an author-selected package target. */
  async update(workspaceId: string, location: PluginControlLocation, target: string,
    signal?: AbortSignal, authority?: NativeMutationAuthority): Promise<void> {
    const requested = publicLocation(location)
    if (typeof target !== "string") throw new PluginControlsError("Invalid plugin package target", "invalid")
    validatePluginSourceSpec(target)
    const admission = new NativeMutationAdmission(authority)
    // Bound cancellation even when a native adapter ignores its signal. Every continuation
    // checks that same signal before dispatch; native target serialization stays downstream.
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(admission.failure(signal!.reason))
      if (signal?.aborted) return abort()
      signal?.addEventListener("abort", abort, { once: true })
      const work = async () => {
        await admission.revalidate()
        signal?.throwIfAborted()
        const connection = await this.deps.workspaceManager.getSharedServiceConnection(workspaceId)
        if (!connection) throw new PluginControlsError("OpenCode service is unavailable", "unavailable")
        const checkpoint = async () => {
          await admission.revalidate()
          signal?.throwIfAborted()
          connection.assertCurrent()
        }
        await checkpoint()
        const snapshot = await this.deps.controls.read(workspaceId, requested, signal)
        await checkpoint()
        const canonical = publicLocation(snapshot.location)
        if (!snapshot.runtime.some(entry => entry.source.type === "package" && entry.source.target === target)
          || snapshot.runtime.some(entry => entry.id === target)
          || snapshot.controls.some(entry => entry.id === target)
          || snapshot.configured.rules.some(rule => rule.selector === target)) {
          throw new PluginControlsError("Package target is absent from the authorized runtime inventory", "forbidden")
        }
        const owned = await this.deps.workspaceManager.ownsLocation(workspaceId, canonical, connection.client, signal)
        await checkpoint()
        if (!owned) throw new PluginControlsError("Location is not owned by this workspace", "forbidden")
        const options = { ...locationRequestOptions(canonical), ...(signal ? { signal } : {}) }
        connection.assertCurrent()
        signal?.throwIfAborted()
        admission.admit()
        await connection.client.plugin.update({ location: { directory: canonical.directory }, targets: [target] }, options)
        await checkpoint()
        signal?.throwIfAborted()
        connection.assertCurrent()
        admission.assertCurrent()
      }
      work().then(resolve, error => reject(admission.failure(error)))
        .finally(() => signal?.removeEventListener("abort", abort))
    })
  }
}

function publicLocation(location: PluginControlLocation): PluginControlLocation {
  if (!location || typeof location.directory !== "string" || !location.directory.trim()
    || location.directory.length > 32_768 || /\p{Cc}/u.test(location.directory)
    || Object.keys(location).some(key => key !== "directory")) {
    throw new PluginControlsError("Invalid public OpenCode location", "invalid")
  }
  return { directory: location.directory }
}
