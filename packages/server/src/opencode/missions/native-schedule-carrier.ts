import type { AISDKHooks } from "@opencode/plugin/effect/aisdk"
import type { SessionCompaction, SessionContext, SessionHttpRequest, SessionTitle } from "@opencode/plugin/effect/session"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleWake } from "./native-schedule-transport-contract"

export const NATIVE_SCHEDULE_CARRIER_MODEL = Object.freeze({ providerID: "codenomad-missions-local", id: "schedule-noop" })
export const NATIVE_SCHEDULE_CARRIER_TITLE = "Mission schedule carrier"
const summary = "Mission schedule carrier. Read exact wake messages and durable mappings for correlation."
const finish = () => ({ finishReason: { unified: "stop", raw: "stop" } as const,
  usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } })

// Shared across concurrent cold language hooks; carries no session/wake state.
const language: NonNullable<AISDKHooks["language"]["language"]> = Object.freeze({
  specificationVersion: "v3", provider: NATIVE_SCHEDULE_CARRIER_MODEL.providerID,
  modelId: NATIVE_SCHEDULE_CARRIER_MODEL.id, supportedUrls: {},
  doGenerate: async () => ({ content: [], warnings: [], ...finish() }),
  doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: "finish", ...finish() })
    controller.close()
  } }) }),
})

export { createNativeScheduleCarrierProvider } from "./native-schedule-carrier-provider"

/** Register through the public session/aisdk hooks. owns must use exact durable
 * carrier identities; admission belongs exclusively to the context → RPC path. */
export function nativeScheduleCarrierHooks(owns: (sessionID: string) => boolean) {
  return {
    language(event: AISDKHooks["language"]) {
      if (event.model.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID) return
      if (event.model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id) throw new Error("schedule-carrier-model")
      event.language = language
    },
    context(event: SessionContext) {
      if (!owns(event.sessionID)) return
      if (event.model.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID || event.model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id)
        throw new Error("schedule-carrier-model")
      event.tools = {}
    },
    title(event: SessionTitle) { if (owns(event.sessionID)) event.result = NATIVE_SCHEDULE_CARRIER_TITLE },
    compaction(event: SessionCompaction) { if (owns(event.sessionID)) event.result = { summary } },
    httpRequest(event: SessionHttpRequest) { if (owns(event.sessionID)) throw new Error("schedule-carrier-provider-http") },
  }
}

export type NativeScheduleCarrierMapping = Omit<NativeScheduleWake, "run" | "messageID">
export type NativeScheduleCarrierCandidate = NativeScheduleWake & { dueAt: number; late: boolean }

/** Bounded model-context hints only. RPC must point-read the native user message,
 * revalidate mapping/Location/state, and reserve/advance high-water under CAS. */
export function nativeScheduleCarrierWakes(mapping: NativeScheduleCarrierMapping, highWater: number,
  messages: readonly unknown[], completedCompactionIDs: readonly string[] = []): NativeScheduleCarrierCandidate[] {
  if (!Number.isSafeInteger(highWater) || highWater < 0 || messages.length > 128
    || completedCompactionIDs.length > 128 || Buffer.byteLength(JSON.stringify(messages), "utf8") > 1024 * 1024) throw new Error("schedule-carrier-coverage")
  const candidates = new Map<number, NativeScheduleCarrierCandidate>()
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") throw new Error("schedule-carrier-context")
    const message = raw as { role?: unknown; id?: unknown; metadata?: { schedule?: unknown } }
    if (message.role !== "user") continue
    const schedule = message.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    // Native compaction projects a user-role checkpoint. Only the exact IDs
    // classified by a bounded native context read may be ignored here; prose
    // and self-declared markers never supply that classification or wake authority.
    if (schedule === undefined && typeof message.id === "string" && completedCompactionIDs.includes(message.id)) continue
    if (!schedule || schedule.id !== mapping.scheduleID || !Number.isSafeInteger(schedule.run)
      || Number(schedule.run) < 1 || !Number.isSafeInteger(schedule.dueAt) || Number(schedule.dueAt) < 0
      || typeof schedule.late !== "boolean" || typeof message.id !== "string") throw new Error("schedule-carrier-wake")
    const candidate = { ...mapping, run: Number(schedule.run), messageID: message.id, dueAt: Number(schedule.dueAt), late: schedule.late }
    assertNativeScheduleWake(candidate)
    if (candidate.run <= highWater) continue
    const previous = candidates.get(candidate.run)
    if (previous && (previous.dueAt !== candidate.dueAt || previous.late !== candidate.late)) throw new Error("schedule-carrier-wake")
    candidates.set(candidate.run, candidate)
  }
  const ordered = [...candidates.values()].sort((a, b) => a.run - b.run)
  if (ordered.length > 32 || ordered.some((candidate, index) => candidate.run !== highWater + index + 1))
    throw new Error("schedule-carrier-coverage")
  return ordered
}
