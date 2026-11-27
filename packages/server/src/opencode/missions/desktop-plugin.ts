import type { Plugin } from "@opencode/plugin"
import type { MissionInputTransport, NativeMissionSession } from "../../missions/control-types"
import { followPresence } from "../desktop-plugin-presence"
import { setupMissionsBusiness, setupMissionsPlugin, type MissionBusinessRoute } from "../missions-plugin"
import { readMissionConfigurations, resolveMissionProfileDefaults, sendMissionInput } from "../automation-plugin"
import { isCleanupReason } from "../../missions/cleanup-projection"
import { MissionJournal } from "../../missions/journal"
import { MissionJournalIndex } from "../../missions/journal-index"
import { hintsShowWork, retainMissionWork } from "./lifetime"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"
import type { MissionDocumentAccess } from "../../missions/mission-document-one-time"
import { boundedMissionList } from "../../missions/inspect-view"
import type { MissionControl } from "../../missions/control"
import type { NativeJournalRange } from "./native-journal-range"
import type { NativeCoordinatorGoalRuntime } from "./native-coordinator-goal"
import { registerMissionCalendarTool } from "./mission-calendar-tool"
import { missionActorResumeInput } from "../../missions/native-actor-lifecycle"
import { missionIsRunning } from "../../missions/lifecycle-model"
import { stableToken } from "../../missions/receipt-identity"

export interface NativeDocumentBusiness {
  select(sessionID: string): Promise<MissionBusinessRoute | undefined>
  prepare(sessionID: string): Promise<boolean>
}

/** One-time Missions only: the `codenomad-missions/v2` journal. Setup never
 * reads, creates or repairs the retired `authority-v2` namespace. */
export function desktopPlugin(presenceDirectory: string | readonly string[], humanGate?: NativeHumanAnswerGate, documents?: MissionDocumentAccess,
  documentBusiness?: NativeDocumentBusiness, range?: NativeJournalRange | (() => NativeJournalRange | undefined),
  coordinatorGoal?: NativeCoordinatorGoalRuntime): Plugin.Plugin {
  return {
    id: "codenomad.missions",
    setup: async ctx => {
      // One per activation, never module-global: a reloaded revision may reuse this module.
      const index = new MissionJournalIndex()
      const storage = range ? { ...ctx.storage, get range() { return typeof range === "function" ? range() : range } } : ctx.storage
      const journal = new MissionJournal(storage, ctx.location.project.id, ctx.location.project.canonical, undefined, index)
      let ordinary: MissionBusinessRoute | undefined
      let core: MissionControl | undefined
      // Missions registers without a backend during a calendar run, and after an OpenCode restart
      // while a Mission was running. This key outlives the process: an activation reads the
      // journal only for a project whose Missions were registered when the service stopped.
      const registered = `codenomad-missions/registered-v1/${stableToken(`${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24)}`
      let runs = 0, marked = await ctx.storage.get(registered).then(value => value !== undefined, () => false)
      const mark = async (next: boolean) => {
        if (marked === next) return
        marked = next
        await (next ? ctx.storage.set(registered, true) : ctx.storage.remove(registered)).catch(() => undefined)
      }
      // Prepared and paused Missions wait for a person: only a running one resumes by itself.
      let resumable = marked && await journal.snapshot().then(snapshot => snapshot.missions.some(mission => mission.status === "active" && missionIsRunning(mission)), () => false)
      if (!resumable) await mark(false)
      // Without a CodeNomad backend claiming the coordinator, the plugin sends through its own session API.
      const start: NonNullable<MissionInputTransport["lifecycle"]> = async (coordinatorID, input) => {
        const mission = (await core?.snapshot())?.missions.find(mission => mission.id === input.missionID), operation = mission?.control
        if (!mission || mission.coordinatorSessionId !== coordinatorID || operation?.id !== input.operationID || operation.action !== "start"
          || !operation.pending.includes(input.sessionID)) throw new Error("Mission controls unavailable")
        const route = missionActorResumeInput(mission.id, operation.id, input.sessionID, coordinatorID)
        const admission = await ctx.session.synthetic({ ...route, ...(input.startText === undefined ? {} : { text: input.startText }) })
        return { nativeAcknowledgement: { missionID: mission.id, operationID: operation.id, sessionID: input.sessionID,
          action: "start", disposition: "start-admitted", admission } }
      }
      const disposeBusiness = await setupMissionsBusiness(ctx, async (sessionID, name, raw) => {
        const author = ordinary && { ...ordinary, readSessionID: sessionID }
        // Separate preparations always belong to the project journal, including
        // when their actual author executes inside an isolated passage journal.
        const input = raw as { list?: boolean; missionID?: string; configurations?: true | string; content?: { kind?: string } }
         if (name === "prepare" || name === "schedule" || name === "inspect" && (input.configurations !== undefined || input.content?.kind === "configuration")) return author
        const own = author && name === "inspect" && (input.list || input.missionID)
          ? await author.control.listMissions(sessionID) : undefined
         if (author && own?.some(mission => mission.missionID === input.missionID)) return author
        const selected = await documentBusiness?.select(sessionID)
        if (selected && author && own && input.list) {
          return { ...selected, preparationAvailable: true, listMissions: async (offset, operationID) => {
            const use = (control: MissionBusinessRoute["control"]) => control.inspectTool(selected.readSessionID, { list: true }, operationID, undefined)
            // The isolated passage owns exactly one mission, so its list fits whole.
            const source = await (selected.execute ? selected.execute(use) : use(selected.control)) as { missions: Awaited<ReturnType<MissionControl["listMissions"]>> }
            selected.current(); author.current()
            const missions = [...new Map([...source.missions, ...own].map(mission => [mission.missionID, mission])).values()]
            return boundedMissionList(missions.sort((a, b) => b.createdAt - a.createdAt), offset)
          } }
        }
        return selected ? { ...selected, preparationAvailable: Boolean(author) } : author
       }, (sessionID, input) => sendMissionInput(sessionID, "schedule", input),
          (sessionID, input) => sendMissionInput(sessionID, "project-read", input),
           (sessionID, input) => sendMissionInput(sessionID, "project-control", input),
           (sessionID, input) => sendMissionInput(sessionID, "settings", input))
      const promptHook = await ctx.session.hook("prompt", async event => {
        await documentBusiness?.prepare(event.sessionID)
      })
        .catch(async error => { await disposeBusiness(); throw error })
      let presence: Awaited<ReturnType<typeof followPresence>>
      try { presence = await followPresence(presenceDirectory, async () => {
        try {
          const dispose = await setupMissionsPlugin({ ...ctx, storage }, {
          prompt: (coordinatorID, input) => sendMissionInput(coordinatorID, "prompt", input, () => ctx.session.prompt(input)),
          // Recovery needs the backend's fresh native observations: it is never sent without one.
          synthetic: (coordinatorID, input) => sendMissionInput(coordinatorID, "synthetic", input,
            (input.metadata["codenomad.mission"] as { kind?: unknown } | undefined)?.kind === "recovery" ? undefined : () => ctx.session.synthetic(input)),
          lifecycle: (coordinatorID, input) => sendMissionInput(coordinatorID, "lifecycle", input, () => start(coordinatorID, input)),
           prepare: (coordinatorID, input) => sendMissionInput(coordinatorID, "prepare", input),
           schedule: (sessionID, input) => sendMissionInput(sessionID, "schedule", input),
           verifyProjectControl: proof => sendMissionInput(proof.principal.sessionID, "project-control-verify", proof),
           requestProjectUpdate: proof => sendMissionInput(proof.principal.sessionID, "project-update", proof),
          resolveCreationDefaults: resolveMissionProfileDefaults,
          readConfigurations: readMissionConfigurations,
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
            core = control
          }, beforeTool: async () => {}, beforeJournalWrite: async () => {} },
          (coordinatorID, input) => sendMissionInput(coordinatorID, "create-root", input, async () => undefined) as Promise<NativeMissionSession | undefined>,
          humanGate, false, index, documents, coordinatorGoal)
          resumable = false
          await mark(true)
          void coordinatorGoal?.reconcileProject(true).catch(() => undefined)
          return async () => { ordinary = core = undefined; await dispose() }
        } catch (error) { ordinary = core = undefined; throw error }
      }, console.error, async () => {
        const retained = runs > 0 || await retainMissionWork(() => journal.snapshot(), () => journal.readHints(hintsShowWork))
        if (!retained) await mark(false)
        return retained
      }, undefined, () => runs > 0 || resumable) }
      catch (error) { await disposeBusiness(); await promptHook.dispose(); index.dispose(); throw error }
      // A calendar run registers Missions for each step that needs them, with or without a backend.
      const calendar = await registerMissionCalendarTool(ctx, async work => {
        runs++
        try {
          for (let pass = 0; !core && pass < 2; pass++) await presence.reconcile()
          if (!core) throw new Error("mission-calendar-unavailable")
          return await work()
        } finally { runs-- }
      }).catch(async error => { await disposeBusiness(); await promptHook.dispose(); await presence(); index.dispose(); throw error })
      return async () => { ordinary = core = undefined; await calendar.dispose(); await disposeBusiness(); await promptHook.dispose();
        await presence(); index.dispose() }
    },
  }
}
