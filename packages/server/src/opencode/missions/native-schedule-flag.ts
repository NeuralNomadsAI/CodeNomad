import { Context, Effect, Option } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ConfigEntry } from "@opencode/client"
import { nativeAutomationsSetting } from "./native-automations-setting"

/** `scheduleFlag` reply: its original two fields, readable by every backend. */
export type NativeScheduleFlag = { enabled: boolean; provenance: "environment" | "experimental-block" | "all-flags" | "channel-default" }
/** `scheduleSetting` reply: also names the deciding source and every hidden OFF. */
export type NativeScheduleSetting = { enabled: boolean
  provenance: NativeScheduleFlag["provenance"] | "automations-setting"; path?: string; hiddenOff: string[] }
export const nativeScheduleFlagReply = ({ enabled, provenance }: NativeScheduleSetting): NativeScheduleFlag =>
  ({ enabled, provenance: provenance === "automations-setting" ? "experimental-block" : provenance })

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
  const resolved = flags.resolve(entries)
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) throw new Error("Native schedule flag resolution unavailable")
  const states = Object.values(resolved)
  // Runtimes with the top-level `automations` setting resolve their other flags but not it.
  // A resolver with no well-formed flag at all proves nothing.
  if (!("automations" in resolved)) {
    if (!states.length || !states.every(state => state && typeof state.enabled === "boolean" && ["env", "config", "default"].includes(state.source)))
      throw new Error("Native schedule flag resolution unavailable")
    const setting = nativeAutomationsSetting(entries)
    current()
    return { enabled: setting.enabled, provenance: setting.source === "setting" ? "automations-setting"
      : setting.source === "legacy-off" ? "experimental-block" : setting.source === "environment" ? "environment" : "channel-default",
      ...(setting.path ? { path: setting.path } : {}), hiddenOff: setting.hiddenOff } satisfies NativeScheduleSetting
  }
  const state = resolved.automations
  if (!state || typeof state.enabled !== "boolean" || !["env", "config", "default"].includes(state.source))
    throw new Error("Native schedule flag resolution unavailable")
  const block = [...entries].reverse().find(entry => entry.type === "document" && entry.info.experimental !== undefined)
  const provenance: NativeScheduleFlag["provenance"] = state.source === "env" ? "environment"
    : state.source === "default" ? "channel-default"
    : block?.type === "document" && (block.info.experimental?.automations !== undefined
      || block.info.experimental?.schedules !== undefined) ? "experimental-block" : "all-flags"
  current()
  // Its entries keep every layer's block, so the backend checks hidden OFF itself.
  return { enabled: state.enabled, provenance, hiddenOff: [] } satisfies NativeScheduleSetting
})
