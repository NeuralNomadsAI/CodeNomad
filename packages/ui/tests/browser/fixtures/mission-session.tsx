import "./session"
import { missionStore } from "../../../src/stores/missions"
import { updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { showSessionChatFor } from "../../../src/stores/session-previews"
import { openFilePreview } from "../../../src/stores/files-preview"
import { sseManager } from "../../../src/lib/sse-manager"

const fixture = (window as any).fixture
Object.assign(fixture, {
  // A running execution with an open text part, as message-scroll-switch.tsx starts it.
  startStream: () => {
    ;(sseManager as any).handleEvent("browser-instance", { id: `mission-ev_${Date.now()}`, type: "session.execution.started", created: Date.now(),
      location: { directory: "/fixture" }, data: { sessionID: "browser-session" } })
    fixture.start()
  },
  readFile: () => openFilePreview("browser-instance", { kind: "workspace", sessionId: "browser-session", slug: "fixture", directory: "/fixture", path: "README.md" }),
  // Loads the Mission map, so a later readMission opens its reader synchronously.
  loadMissions: () => missionStore.ensure("browser-instance"),
  readMission: async () => {
    await missionStore.ensure("browser-instance")
    showSessionChatFor("browser-session", "/fixture")
    updateMissionProjectView("/fixture", { reader: { missionId: "reader", kind: "report", itemId: "report-reader" } })
  },
})
