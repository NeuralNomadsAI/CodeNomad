import "./session"
import { missionStore } from "../../../src/stores/missions"
import { updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { showSessionChatFor } from "../../../src/stores/session-previews"
import { openFilePreview } from "../../../src/stores/files-preview"

Object.assign((window as any).fixture, {
  readFile: () => openFilePreview("browser-instance", { kind: "workspace", sessionId: "browser-session", slug: "fixture", directory: "/fixture", path: "README.md" }),
  readMission: async () => {
    await missionStore.ensure("browser-instance")
    showSessionChatFor("browser-session", "/fixture")
    updateMissionProjectView("/fixture", { reader: { missionId: "reader", kind: "report", itemId: "report-reader" } })
  },
})
