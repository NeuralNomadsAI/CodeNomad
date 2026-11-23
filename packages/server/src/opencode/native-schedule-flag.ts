import { z } from "zod"
import type { ConfigEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { PluginControlLocation } from "../api-types"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { effectiveMissionExperimental } from "./native-experimental-settings"
import { INLINE_CONFIG_SOURCE, REMOTE_CONFIG_SOURCE } from "./missions/native-automations-setting"

const provenance = z.enum(["environment", "experimental-block", "all-flags", "channel-default", "automations-setting"])
export const nativeScheduleFlagSchema = z.object({ enabled: z.boolean(), provenance,
  path: z.string().min(1).max(4096).optional(), hiddenOff: z.array(z.string().min(1).max(4096)).max(256).default([]) }).strict()
export type NativeScheduleFlag = z.infer<typeof nativeScheduleFlagSchema>

/** The daemon, rather than the desktop backend, owns environment and channel defaults.
 * `scheduleSetting` also names the deciding source and hidden OFF layers; a bundle
 * without it answers the original `scheduleFlag`. */
export async function readNativeScheduleFlag(connection: ServiceConnection, location: PluginControlLocation) {
  connection.assertCurrent()
  const rpc = connection.client.rpc(CODENOMAD_MISSIONS_RPC), options = () => ({ location, signal: AbortSignal.timeout(5_000) })
  let raw: unknown
  try { raw = typeof rpc.scheduleSetting === "function" ? await rpc.scheduleSetting({}, options()) : await Promise.reject({ type: "rpc.method_not_found" }) }
  catch (error) {
    // Only a bundle without the method answers the original reply; any other failure stays one.
    if ((error as { type?: unknown } | null)?.type !== "rpc.method_not_found") throw error
    connection.assertCurrent(); raw = await rpc.scheduleFlag({}, options())
  }
  const result = nativeScheduleFlagSchema.parse(raw)
  connection.assertCurrent()
  return result
}

export function nativeScheduleFlagOrigin(entries: readonly ConfigEntry[], flag: NativeScheduleFlag): string | null {
  // Runtimes with the top-level setting name the deciding source themselves; pathless config has no file.
  if (flag.path) return flag.path === INLINE_CONFIG_SOURCE || flag.path === REMOTE_CONFIG_SOURCE ? null : flag.path
  if (flag.provenance === "automations-setting") return null
  if (flag.provenance === "experimental-block") return effectiveMissionExperimental(entries).origin
  if (flag.provenance !== "all-flags") return null
  const entry = [...entries].reverse().find(entry => entry.type === "document" && entry.info.experimental?.all_flags !== undefined)
  return entry?.type === "document" ? entry.path ?? null : null
}
