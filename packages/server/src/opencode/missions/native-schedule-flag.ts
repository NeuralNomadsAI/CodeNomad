import { Context, Effect, Option } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ConfigEntry } from "@opencode/client"

export type NativeScheduleFlag = { enabled: boolean; provenance: "environment" | "experimental-block" | "all-flags" | "channel-default" }

/** Read in the receiving Location graph, with the daemon's own overrides/channel.
 * The private Flag.resolve/Config.entries shapes are checked before use. */
export const readNativeScheduleFlag = Effect.fn("missions.readScheduleFlag")(function* (ctx: Pick<Plugin.Context, "location">) {
  const graph = yield* Effect.context<never>()
  const required = (name: string) => {
    const service = Context.getOption(graph, Context.Service<never, unknown>(name))
    if (Option.isNone(service)) throw new Error("Native schedule flag contract unavailable")
    return service.value
  }
  const config = required("@opencode/Config") as { entries(): Effect.Effect<ConfigEntry[], unknown> }
  const flags = required("@opencode/Flag") as { resolve(entries: readonly ConfigEntry[]): Record<string, { enabled: boolean; source: string }> }
  const location = required("@opencode/Location") as { directory: string; workspaceID?: string; project: { id: string; canonical: string } }
  const lifecycle = required("@opencode/LocationLifecycle") as { isClosed(): boolean }
  const current = () => {
    if (typeof lifecycle.isClosed !== "function" || lifecycle.isClosed() !== false
      || location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project?.id !== ctx.location.project.id || location.project?.canonical !== ctx.location.project.canonical)
      throw new Error("Native schedule flag Location retired")
  }
  current()
  if (typeof config.entries !== "function" || typeof flags.resolve !== "function") throw new Error("Native schedule flag contract unavailable")
  const effect = config.entries()
  if (!Effect.isEffect(effect)) throw new Error("Native schedule flag configuration unavailable")
  const entries = yield* effect
  if (!Array.isArray(entries) || entries.length > 256 || entries.some(entry => !entry
    || entry.type !== "directory" && (entry.type !== "document" || !entry.info || typeof entry.info !== "object")))
    throw new Error("Native schedule flag configuration incomplete")
  const state = flags.resolve(entries)?.schedules
  if (!state || typeof state.enabled !== "boolean" || !["env", "config", "default"].includes(state.source))
    throw new Error("Native schedule flag resolution unavailable")
  const block = [...entries].reverse().find(entry => entry.type === "document" && entry.info.experimental !== undefined)
  const provenance: NativeScheduleFlag["provenance"] = state.source === "env" ? "environment"
    : state.source === "default" ? "channel-default"
    : block?.type === "document" && block.info.experimental?.schedules !== undefined ? "experimental-block" : "all-flags"
  current()
  return { enabled: state.enabled, provenance } satisfies NativeScheduleFlag
})
