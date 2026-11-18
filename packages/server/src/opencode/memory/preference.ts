import type { EventBus } from "../../events/bus"
import { readMemoryEnabled } from "../../memory/service"
import type { SettingsService } from "../../settings/service"
import type { DesktopPluginLifecycle } from "../desktop-plugin-lifecycle"
import { memoryLeaseContent } from "./activation"

/**
 * Carries `server.memoryEnabled` in every memory lease of this backend, so the
 * native tool is registered only while memory is enabled. Applied immediately and
 * after every server config change; an unreadable preference requests nothing,
 * as execution would reject it. Returns the unsubscribe.
 */
export function followMemoryPreference(
  settings: Pick<SettingsService, "getRawConfigOwner">,
  events: Pick<EventBus, "on" | "off">,
  lifecycle: Pick<DesktopPluginLifecycle, "setLeaseContent">,
  onError: (error: unknown) => void = () => {},
): () => void {
  const sync = () => {
    let enabled = false
    try { enabled = readMemoryEnabled(settings) } catch { /* Requests nothing. */ }
    // The content is assigned synchronously; lease rewrites retry at their next heartbeat.
    void lifecycle.setLeaseContent(memoryLeaseContent(enabled)).catch(onError)
  }
  const changed = (event: { owner?: string }) => {
    if (event.owner === "server" || event.owner === "*") sync()
  }
  events.on("storage.configChanged", changed)
  sync()
  return () => { events.off("storage.configChanged", changed) }
}
