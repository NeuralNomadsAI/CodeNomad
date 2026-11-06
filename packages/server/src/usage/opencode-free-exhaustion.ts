import type { ServiceConnection } from "../workspaces/opencode-service"
import { isOpenCodeFreeModel, openCodeFreeWindow } from "./opencode-free-estimate"

const MAX_STEPS = 1024
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
type Step = { model: string | null; free: boolean; started: number; failed: boolean }
type State = { steps: Map<string, Step>; failedAt?: number; resetAt?: number }

/** Display-only evidence, shared by free models on one native connection. */
export function createOpenCodeFreeExhaustion() {
  let states = new WeakMap<ServiceConnection, State>()
  return {
    observe(connection: ServiceConnection, input: unknown, now = Date.now()) {
      const event = input as { type?: unknown; created?: unknown; data?: {
        sessionID?: unknown; assistantMessageID?: unknown; model?: { providerID?: unknown; id?: unknown }; error?: { type?: unknown }
      } } | undefined
      if (event?.type !== "session.step.started" && event?.type !== "session.step.failed") return
      const data = event.data
      if (!id(data?.sessionID) || !id(data?.assistantMessageID) || typeof event.created !== "number" ||
        !Number.isSafeInteger(event.created) || event.created < 0 || event.created > now) return
      let state = states.get(connection)
      if (!state) { state = { steps: new Map() }; states.set(connection, state) }
      const key = JSON.stringify([data.sessionID, data.assistantMessageID])
      const previous = state.steps.get(key)
      if (event.type === "session.step.started") {
        const model = data.model
        const identity = id(model?.providerID) && id(model?.id) ? JSON.stringify([model.providerID, model.id]) : null
        if (previous) {
          if (previous.model !== identity) { previous.model = null; previous.free = false }
          return
        }
        if (state.steps.size >= MAX_STEPS) state.steps.delete(state.steps.keys().next().value!)
        state.steps.set(key, { model: identity, free: identity !== null && isOpenCodeFreeModel(model!.providerID as string, model!.id as string),
          started: event.created, failed: false })
        return
      }
      if (data.error?.type !== "provider.quota" || !previous?.free || previous.failed || event.created < previous.started) return
      previous.failed = true
      const { resetAt } = openCodeFreeWindow(event.created)
      if (resetAt <= now || (state.failedAt !== undefined && event.created <= state.failedAt)) return
      state.failedAt = event.created
      state.resetAt = resetAt
    },
    exhausted(connection: ServiceConnection, now = Date.now()) {
      return (states.get(connection)?.resetAt ?? 0) > now
    },
    dispose() { states = new WeakMap() },
  }
}

export type OpenCodeFreeExhaustion = ReturnType<typeof createOpenCodeFreeExhaustion>
