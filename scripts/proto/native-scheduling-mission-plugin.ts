// Throwaway prototype plugin: the Missions core without CodeNomad's presence and bridge.
// Starts go through the public plugin session API, and one Code Mode tool lets an
// Automation launch an ordinary one-time Mission unless the previous one still runs.
import { setupMissionsPlugin } from "../../packages/server/src/opencode/missions-plugin"
import { controlResumeAdmissionID } from "../../packages/server/src/missions/receipt-identity"
import type { MissionControl } from "../../packages/server/src/missions/control"

const text = { type: "string", minLength: 1 }

export default { id: "codenomad.missions", setup: async (ctx: any) => {
  let control: MissionControl | undefined
  const dispose = await setupMissionsPlugin(ctx, {
    prompt: (_coordinatorID, input) => ctx.session.prompt(input),
    synthetic: (_coordinatorID, input) => ctx.session.synthetic(input),
    // What CodeNomad's bridge does on Play, done here by the plugin itself.
    lifecycle: async (_coordinatorID, input) => {
      const admission = await ctx.session.synthetic({ sessionID: input.sessionID, id: controlResumeAdmissionID(input.operationID, input.sessionID),
        text: input.startText ?? "Begin the mission.", description: "Mission start", delivery: "queue", resume: true,
        metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } } })
      return { nativeAcknowledgement: { missionID: input.missionID, operationID: input.operationID, sessionID: input.sessionID,
        action: "start", disposition: "start-admitted", admission } }
    },
  }, { configure: async value => { control = value }, beforeTool: async () => {}, beforeJournalWrite: async () => {} })
  const tools = await ctx.tool.transform((editor: any) => editor.add({
    name: "mission_launch", description: "Starts one Mission for a calendar occurrence unless the calendar's previous Mission is still active.",
    input: { type: "object", properties: { calendar: text, key: text, title: text, objective: text }, required: ["calendar", "key", "title", "objective"], additionalProperties: false },
    options: { namespace: "proto", codemode: true, permission: "proto_mission_launch" },
    execute: async (input: { calendar: string; key: string; title: string; objective: string }) => {
      if (!control) throw new Error("Missions unavailable")
      const slot = `proto-calendars/${input.calendar}`, last = await ctx.storage.get(slot) as { missionID: string } | undefined
      const previous = last ? (await control.mission(last.missionID)).mission : undefined
      if (previous?.status === "active") return { content: JSON.stringify({ busy: true, missionID: previous.id }) }
      const created = await control.create({ requestID: `${input.calendar}_${input.key}`.slice(0, 100), title: input.title, objective: input.objective, template: "custom", prepared: true })
      await ctx.storage.set(slot, { missionID: created.mission.id })
      const started = await control.lifecycle({ missionID: created.mission.id, requestID: `play_${input.key}`.slice(0, 100), expectedRevision: created.mission.revision, action: "start" })
      return { content: JSON.stringify({ busy: false, missionID: created.mission.id, coordinatorSessionID: created.mission.coordinatorSessionId,
        status: started.mission.status, previous: previous ? { id: previous.id, status: previous.status } : null }) }
    },
  }))
  return async () => { await tools?.dispose?.(); await dispose() }
} }
