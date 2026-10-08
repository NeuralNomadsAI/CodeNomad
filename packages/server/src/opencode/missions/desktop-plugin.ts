import type { Plugin } from "@opencode/plugin"
import type { NativeMissionSession } from "../../missions/control-types"
import { followPresence } from "../desktop-plugin-presence"
import { setupMissionsPlugin } from "../missions-plugin"
import { sendMissionInput } from "../automation-plugin"
import { isCleanupReason } from "../../missions/cleanup-projection"
import { MissionJournal } from "../../missions/journal"
import { retainMissionWork } from "./lifetime"
import { NativeMissionAuthorityStore } from "../../missions/authority-store"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"

export function desktopPlugin(presenceDirectory: string | readonly string[], ownerReady: (ready: boolean) => void = () => {}, humanGate?: NativeHumanAnswerGate): Plugin.Plugin {
  return {
    id: "codenomad.missions",
    setup: ctx => {
      const journal = new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical)
      return followPresence(presenceDirectory, async () => {
        ownerReady(false)
        try { await new NativeMissionAuthorityStore(ctx.storage, ctx.location.project.id, ctx.location.project.canonical).initialize(); ownerReady(true) }
        catch { ownerReady(false) } // Damaged authority cannot take down independent one-shot Missions.
        try {
          const dispose = await setupMissionsPlugin(ctx, {
          prompt: (coordinatorID, input) => sendMissionInput(coordinatorID, "prompt", input),
          synthetic: (coordinatorID, input) => sendMissionInput(coordinatorID, "synthetic", input),
          lifecycle: (coordinatorID, input) => sendMissionInput(coordinatorID, "lifecycle", input),
          cleanup: async (coordinatorID, input) => {
            const result = await sendMissionInput(coordinatorID, "cleanup", input) as { outcome?: unknown; reason?: unknown }
            if (result?.outcome !== "removed" && result?.outcome !== "retained") throw new Error("Invalid mission cleanup acknowledgement")
            return { outcome: result.outcome, ...(isCleanupReason(result.reason) ? { reason: result.reason } : {}) }
          },
          }, undefined, (coordinatorID, input) => sendMissionInput(coordinatorID, "create-root", input) as Promise<NativeMissionSession>, humanGate)
          return async () => { ownerReady(false); await dispose() }
        } catch (error) { ownerReady(false); throw error }
      }, console.error, () => retainMissionWork(() => journal.snapshot()))
    },
  }
}
