import "./session"
import { missionStore } from "../../../src/stores/missions"
import { updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { showSessionChat } from "../../../src/stores/session-previews"

Object.assign((window as any).fixture, {
  readMission: async () => {
    await missionStore.ensure("browser-instance")
    showSessionChat("/fixture")
    updateMissionProjectView("/fixture", { reader: { missionId: "reader", kind: "report", itemId: "report-reader" } })
  },
})
