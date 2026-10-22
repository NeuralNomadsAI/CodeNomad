import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { sseManager } from "../../../src/lib/sse-manager"
import { getToastHistory } from "../../../src/lib/notifications"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import "../../../src/stores/sessions"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// Two project tabs on one folder: the server delivers each event to both.
const tabs = ["tab-a", "tab-b"], sessionID = "ses_compacted"
await applyUiSettings({ locale: "en", notificationRouting: { sessions: { screen: true, history: true, system: false } } as never })
for (const id of tabs) {
  addInstance({ id, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  setSessions(previous => new Map(previous).set(id, new Map([[sessionID, {
    id: sessionID, instanceId: id, parentId: null, title: "Compaction fixture", agent: "build", model: { providerId: "fixture", modelId: "fixture" },
    status: "working", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "p",
    location: { directory: "/fixture" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  } as never]])))
}
render(() => <Toaster />, document.getElementById("root")!)

;(window as any).fixture = {
  /** One `session.compaction.ended`, as the event stream delivers it to a tab. */
  compacted: (tab: string, id: string, seq: number) => (sseManager as any).handleEvent(tab, {
    id, type: "session.compaction.ended", created: seq, durable: { aggregateID: sessionID, seq, version: 1 },
    location: { directory: "/fixture" }, data: { sessionID, reason: "auto", text: "Summary" },
  }),
  history: () => getToastHistory().map(item => item.message),
}
