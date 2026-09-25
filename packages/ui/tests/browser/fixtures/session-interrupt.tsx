import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { getRootClient } from "../../../src/stores/opencode-client"
import { addInstance, instances, setActiveInstanceId } from "../../../src/stores/instances"
import { abortSession } from "../../../src/stores/session-actions"
import { sessions, setSessions } from "../../../src/stores/session-state"
import { useAppLifecycle } from "../../../src/lib/hooks/use-app-lifecycle"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const instanceId = "interrupt-instance"
const [selected, setSelected] = createSignal("ses_parent")
const client = getRootClient(instanceId)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setActiveInstanceId(instanceId)
const root = { id: "ses_parent", instanceId, title: "Parent", parentId: null, agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, status: "working", time: { created: 1, updated: 1 } } as Session
setSessions(new Map([[instanceId, new Map([
  [root.id, root],
  ["ses_child", { ...root, id: "ses_child", parentId: root.id }],
  ["ses_grandchild", { ...root, id: "ses_grandchild", parentId: "ses_child" }],
])]]))
function Fixture() {
  useAppLifecycle({
    setEscapeInDebounce: () => {}, handleNewInstanceRequest: () => {}, handleCloseActiveTab: async () => {},
    handleNewSession: async () => {}, handleCloseSession: async () => {}, showFolderSelection: () => false,
    setShowFolderSelection: () => {}, getActiveInstance: () => instances().get(instanceId)!,
    getActiveSessionIdForInstance: selected,
  })
  return <PromptInput instanceId={instanceId} instanceFolder="/fixture" sessionId={selected()} isActive={true}
    isSessionBusy={true} onAbortSession={() => abortSession(instanceId, selected())} onSend={async () => {}} />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { select: setSelected, sessionCount: () => sessions().get(instanceId)?.size }
