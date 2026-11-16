import { createSignal } from "solid-js"
import { isWebHost } from "./runtime-env"

// Device-local confirmed consent. The host's shared preferences never enable another device.
export const [backgroundPushActive, setBackgroundPushActive] = createSignal(false)
let projects = new Set<string>()
export function setBackgroundPushProjects(value: string[]) { projects = new Set(value) }
export function backgroundPushCovers(instanceId: string, category: string) {
  return isWebHost() && backgroundPushActive() && projects.has(instanceId) && (category === "needsInput" || category === "sessionDone")
}
