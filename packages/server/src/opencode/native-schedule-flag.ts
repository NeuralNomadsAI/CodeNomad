import { z } from "zod"
import type { ConfigEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { PluginControlLocation } from "../api-types"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { effectiveMissionExperimental } from "./native-experimental-settings"

export const nativeScheduleFlagSchema = z.object({ enabled: z.boolean(),
  provenance: z.enum(["environment", "experimental-block", "all-flags", "channel-default"]) }).strict()
export type NativeScheduleFlag = z.infer<typeof nativeScheduleFlagSchema>

/** The daemon, rather than the desktop backend, owns environment and channel defaults. */
export async function readNativeScheduleFlag(connection: ServiceConnection, location: PluginControlLocation) {
  connection.assertCurrent()
  const result = nativeScheduleFlagSchema.parse(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).scheduleFlag({},
    { location, signal: AbortSignal.timeout(5_000) }))
  connection.assertCurrent()
  return result
}

export function nativeScheduleFlagOrigin(entries: readonly ConfigEntry[], flag: NativeScheduleFlag): string | null {
  if (flag.provenance === "experimental-block") return effectiveMissionExperimental(entries).origin
  if (flag.provenance !== "all-flags") return null
  const entry = [...entries].reverse().find(entry => entry.type === "document" && entry.info.experimental?.all_flags !== undefined)
  return entry?.type === "document" ? entry.path ?? null : null
}
