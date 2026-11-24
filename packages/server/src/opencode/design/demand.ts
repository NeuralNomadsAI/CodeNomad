import type { PanelExtensionSummary } from "../../panel-extensions/contract"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import type { DesktopPluginLifecycle } from "../desktop-plugin-lifecycle"
import { designLeaseContent } from "./activation"

/** The extension permission whose grant makes this backend request the Design agent. */
export const DESIGN_AGENT_PERMISSION = "opencode.designAgent"

/** A backend requests Design while an installed, enabled extension declares the permission. */
export function extensionsRequestDesign(entries: readonly PanelExtensionSummary[]): boolean {
  return entries.some(entry => entry.enabled && (entry.manifest.permissions as readonly string[]).includes(DESIGN_AGENT_PERMISSION))
}

/**
 * Returns a refresh that derives the request from the extension store and writes
 * it into every retained session-pruning lease. Calls during a refresh coalesce
 * into one trailing pass; an unreadable store requests nothing.
 */
export function designRequestRefresher(
  store: Pick<PanelExtensionStore, "list">,
  lifecycle: Pick<DesktopPluginLifecycle, "setLeaseContent">,
) {
  let pending: Promise<void> | undefined
  let queued = false
  return function refresh(): Promise<void> {
    if (pending) {
      queued = true
      return pending
    }
    pending = (async () => {
      try {
        do {
          queued = false
          // Always asynchronous, so the worker never settles before `pending` is assigned.
          const requested = await (async () => extensionsRequestDesign(await store.list()))().catch(() => false)
          await lifecycle.setLeaseContent(designLeaseContent(requested))
        } while (queued)
      } finally {
        // In the same synchronous step as the last `queued` check: a later call starts a new pass.
        pending = undefined
      }
    })()
    return pending
  }
}
