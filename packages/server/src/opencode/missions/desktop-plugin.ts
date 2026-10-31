import type { Plugin } from "@opencode/plugin"
import type { NativeMissionSession } from "../../missions/control-types"
import { followPresence } from "../desktop-plugin-presence"
import { setupMissionsBusiness, setupMissionsPlugin, type MissionBusinessRoute } from "../missions-plugin"
import { selectNativePassageBusiness, prepareNativePassageSession, retireNativePassageBusiness } from "./native-passage-business"
import { sendMissionInput } from "../automation-plugin"
import { isCleanupReason } from "../../missions/cleanup-projection"
import { MissionJournal } from "../../missions/journal"
import { MissionJournalIndex } from "../../missions/journal-index"
import { hintsShowWork, retainMissionWork } from "./lifetime"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"
import type { MissionDocumentAccess } from "../../missions/mission-document-one-time"

export interface NativeDocumentBusiness {
  select(sessionID: string): Promise<MissionBusinessRoute | undefined>
  prepare(sessionID: string): Promise<boolean>
}

/** One-time Missions only: the `codenomad-missions/v2` journal. Setup never
 * reads, creates or repairs the retired `authority-v2` namespace. */
export function desktopPlugin(presenceDirectory: string | readonly string[], humanGate?: NativeHumanAnswerGate, documents?: MissionDocumentAccess,
  documentBusiness?: NativeDocumentBusiness): Plugin.Plugin {
  return {
    id: "codenomad.missions",
    setup: async ctx => {
      // One per activation, never module-global: a reloaded revision may reuse this module.
      const index = new MissionJournalIndex()
      const journal = new MissionJournal(ctx.storage, ctx.location.project.id, ctx.location.project.canonical, undefined, index)
      let ordinary: MissionBusinessRoute | undefined
      const disposeBusiness = await setupMissionsBusiness(ctx, async sessionID =>
        await documentBusiness?.select(sessionID) ?? await selectNativePassageBusiness(ctx, sessionID, humanGate)
          ?? (ordinary && { ...ordinary, readSessionID: sessionID }))
      const promptHook = await ctx.session.hook("prompt", async event => {
        if (!await documentBusiness?.prepare(event.sessionID)) await prepareNativePassageSession(ctx, event.sessionID, humanGate)
      })
        .catch(async error => { await disposeBusiness(); throw error })
      let disposePresence: (() => Promise<void>) | undefined
      try { disposePresence = await followPresence(presenceDirectory, async () => {
        try {
          const dispose = await setupMissionsPlugin(ctx, {
          prompt: (coordinatorID, input) => sendMissionInput(coordinatorID, "prompt", input),
          synthetic: (coordinatorID, input) => sendMissionInput(coordinatorID, "synthetic", input),
          lifecycle: (coordinatorID, input) => sendMissionInput(coordinatorID, "lifecycle", input),
          prepare: (coordinatorID, input) => sendMissionInput(coordinatorID, "prepare", input),
          observeTask: (coordinatorID, input) => sendMissionInput(coordinatorID, "task-sessions", input),
          interruptTask: (coordinatorID, input) => sendMissionInput(coordinatorID, "interrupt", input),
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
          (coordinatorID, input) => sendMissionInput(coordinatorID, "create-root", input) as Promise<NativeMissionSession>, humanGate, false, index, documents)
          return async () => { ordinary = undefined; await dispose() }
        } catch (error) { ordinary = undefined; throw error }
      }, console.error, () => retainMissionWork(() => journal.snapshot(), () => journal.readHints(hintsShowWork))) }
      catch (error) { await disposeBusiness(); await promptHook.dispose(); index.dispose(); throw error }
      return async () => { ordinary = undefined; await disposeBusiness(); await promptHook.dispose();
        retireNativePassageBusiness(ctx.location); await disposePresence?.(); index.dispose() }
    },
  }
}
