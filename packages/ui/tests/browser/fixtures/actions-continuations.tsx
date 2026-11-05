import "./multiserver-actions"
import { instances, addInstance, removeInstance } from "../../../src/stores/instances"
import { setSessions, sessions, getSessionDraftPrompt, setAgents } from "../../../src/stores/session-state"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addAttachment, getAttachments } from "../../../src/stores/attachments"
import { createSkillAttachment } from "../../../src/types/attachment"
import { applyOpenCodeDataEvent, syncOpenCodeSessionInbox } from "../../../src/stores/opencode-data"
import { loadMessages } from "../../../src/stores/session-api"
import { alertDialogState } from "../../../src/stores/alerts"
import { applyUiSettings } from "./ui-settings"
import { render } from "solid-js/web"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import AlertDialog from "../../../src/components/alert-dialog"

const dialogRoot = document.createElement("div")
document.body.append(dialogRoot)
render(() => <ConfigProvider><I18nProvider><AlertDialog /></I18nProvider></ConfigProvider>, dialogRoot)

const w = window as any
const a = instances().get("A")!
const source = sessions().get("A")!.get("same")!
let releaseCancel = () => {}, releaseUndo = () => {}, releaseFork = () => {}
const generates: Array<(value: { text: string }) => void> = []
let nativeQueue: any[] = []
let loseCancelAck = false
let cancelStarted = 0, undoStarted = 0, forkStarted = 0
a.client!.session.generate = async () => new Promise<{ text: string }>(resolve => { generates.push(resolve) })
;(a.client!.session as any).revert = { stage: async () => {
  undoStarted++
  await new Promise<void>(resolve => { releaseUndo = resolve })
} }
a.client!.session.fork = async () => {
  forkStarted++
  await new Promise<void>(resolve => { releaseFork = resolve })
  return { id: "fork", location: { directory: "/same/" }, time: { created: 3, updated: 3 },
    fork: { sessionID: "same", boundary: { type: "through", messageID: "queued" } } } as any
}
const row = { id: "queued", type: "user", text: "Original queued text", time: { created: 2 } }
w.continuations = {
  locale: (locale: "en" | "fr" | "he") => applyUiSettings({ locale }),
  alert: alertDialogState,
  draft: (id = "A") => getSessionDraftPrompt(id, "same"),
  attachments: (id = "A") => getAttachments(id, "same"),
  addAttachment: (id = "A") => addAttachment(id, "same", createSkillAttachment("new-skill", "New skill")),
  agents: (values: string[]) => setAgents(previous => new Map(previous).set("A", values.map(id => ({ id, name: id, mode: "primary", description: "Native agent" })))),
  generates: () => generates.length,
  releaseGenerate: (index: number, text: string) => generates[index]({ text }),
  cancelStarted: () => cancelStarted,
  releaseCancel: () => releaseCancel(),
  loseCancelAck: () => { loseCancelAck = true },
  undoStarted: () => undoStarted,
  releaseUndo: () => releaseUndo(),
  forkStarted: () => forkStarted,
  releaseFork: () => releaseFork(),
  closeA() { removeInstance("A", { authoritative: false }) },
  reuseA() {
    addInstance({ ...a, binding: { ...a.binding! }, capabilities: { generation: 2 } as any })
    ;(sdkManager as any).clients.set("A:/workspaces/A/instance", a.client)
    setSessions(previous => new Map(previous).set("A", new Map([["same", { ...source }]])))
  },
  async seedQueued(queued = true) {
    nativeQueue = queued ? [{ id: "queued", sessionID: "same", type: "user", delivery: "queue", time: { created: 2 },
      payload: { text: "Original queued text\n\nhidden native context", metadata: { displayText: "Original queued text" },
        skills: [{ id: "original-skill", name: "Original skill" }] } }] : []
    a.client!.session.inbox.list = async () => nativeQueue as any
    a.client!.session.inbox.cancel = async () => {
      cancelStarted++
      nativeQueue = []
      await new Promise<void>(resolve => { releaseCancel = resolve })
      if (loseCancelAck) throw Object.assign(new Error("Cancellation acknowledgement lost"), { reason: "Transport" })
    }
    if (queued) applyOpenCodeDataEvent("A", "/same/", { id: "queued-event", type: "session.inbox.enqueued", created: 2,
      data: { sessionID: "same", inboxID: "queued", item: nativeQueue[0] } } as any)
    a.client!.message.list = async () => ({ data: [row], cursor: {} }) as any
    await syncOpenCodeSessionInbox("A", "same", "/same/")
    await loadMessages("A", "same", { force: true })
  },
}
