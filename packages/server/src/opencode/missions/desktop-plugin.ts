import type { Plugin } from "@opencode/plugin"
import type { NativeMissionSession } from "../../missions/control-types"
import { followPresence } from "../desktop-plugin-presence"
import { setupMissionsBusiness, setupMissionsPlugin, type MissionBusinessRoute } from "../missions-plugin"
import { selectNativePassageBusiness, prepareNativePassageSession, retireNativePassageBusiness } from "./native-passage-business"
import { sendMissionInput } from "../automation-plugin"
import { isCleanupReason } from "../../missions/cleanup-projection"
import { MissionJournal } from "../../missions/journal"
import { retainMissionWork } from "./lifetime"
import { NativeMissionAuthorityStore } from "../../missions/authority-store"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"

export function desktopPlugin(presenceDirectory: string | readonly string[], ownerReady: (ready: boolean) => void = () => {}, humanGate?: NativeHumanAnswerGate): Plugin.Plugin {
  return {
    id: "codenomad.missions",
    setup: async ctx => {
      const journal = new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical)
      let ordinary: MissionBusinessRoute | undefined
      const disposeBusiness = await setupMissionsBusiness(ctx, async sessionID =>
        await selectNativePassageBusiness(ctx, sessionID, humanGate) ?? (ordinary && { ...ordinary, readSessionID: sessionID }))
      const promptHook = await ctx.session.hook("prompt", event => prepareNativePassageSession(ctx, event.sessionID, humanGate))
        .catch(async error => { await disposeBusiness(); throw error })
      let disposePresence: (() => Promise<void>) | undefined
      try { disposePresence = await followPresence(presenceDirectory, async () => {
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
          }, { configure: async control => {
            const selected: MissionBusinessRoute = { control, readSessionID: "", current: () => {
              if (ordinary !== selected) throw new Error("CodeNomad Missions is no longer available")
            }, beforeTool: async () => {} }
            ordinary = selected
          }, beforeTool: async () => {}, beforeJournalWrite: async () => {} },
          (coordinatorID, input) => sendMissionInput(coordinatorID, "create-root", input) as Promise<NativeMissionSession>, humanGate, false)
          return async () => { ordinary = undefined; ownerReady(false); await dispose() }
        } catch (error) { ordinary = undefined; ownerReady(false); throw error }
      }, console.error, () => retainMissionWork(() => journal.snapshot())) }
      catch (error) { await disposeBusiness(); await promptHook.dispose(); throw error }
      return async () => { ordinary = undefined; await disposeBusiness(); await promptHook.dispose();
        retireNativePassageBusiness(ctx.location); await disposePresence?.() }
    },
  }
}
