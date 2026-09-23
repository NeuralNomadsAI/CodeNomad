import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import PromptInput from "../../../src/components/prompt-input"
import AuthRecoveryDialog from "../../../src/components/auth-recovery-dialog"
import AlertDialog from "../../../src/components/alert-dialog"
import { showAlertDialog } from "../../../src/stores/alerts"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { createInstanceFetch } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addAttachment, getAttachments } from "../../../src/stores/attachments"
import { createFileAttachment } from "../../../src/types/attachment"
import { addInstance, instances } from "../../../src/stores/instances"
import { attachInstanceTab, getInstanceAppTabId, selectAppTab } from "../../../src/stores/app-tabs"
import { useAppSessionCapture } from "../../../src/lib/hooks/use-app-session-capture"
import "../../../src/index.css"

let opens = 0
const [instanceId, setInstanceId] = createSignal("auth-fixture")
const sessionId = "__no_session_draft__"
serverEvents.onOpen(() => { opens++ })
function Composer() {
  const capture = useAppSessionCapture()
  capture.start()
  return <Show when={instances().has(instanceId())}>
    <PromptInput instanceId={instanceId()} instanceFolder="/fixture" sessionId={sessionId} onSend={async () => {}} />
  </Show>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Composer />
  <AlertDialog />
  <AuthRecoveryDialog />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  opens: () => opens,
  seed: (id = "auth-fixture") => {
    setInstanceId(id)
    addInstance({ id, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready" })
    attachInstanceTab(id)
    selectAppTab(getInstanceAppTabId(id))
  },
  attach: () => addAttachment(instanceId(), sessionId, createFileAttachment("/fixture/notes.txt", "notes.txt")),
  attachments: () => getAttachments(instanceId(), sessionId).length,
  lateAlert: () => { void showAlertDialog("Late failure") },
  openProject: async () => {
    try { await serverApi.createWorkspace({ path: "/fixture" }) }
    catch (error) { void showAlertDialog(String(error)) }
  },
  upstream401: () => createInstanceFetch(`${location.origin}/workspaces/fixture/instance/`)(`${location.origin}/workspaces/fixture/instance/api/session`),
}
