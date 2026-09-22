import { render } from "solid-js/web"
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
import "../../../src/index.css"

let opens = 0
serverEvents.onOpen(() => { opens++ })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PromptInput instanceId="auth-fixture" instanceFolder="/fixture" sessionId="session" onSend={async () => {}} />
  <AlertDialog />
  <AuthRecoveryDialog />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  opens: () => opens,
  attach: () => addAttachment("auth-fixture", "session", createFileAttachment("/fixture/notes.txt", "notes.txt")),
  attachments: () => getAttachments("auth-fixture", "session").length,
  openProject: async () => {
    try { await serverApi.createWorkspace({ path: "/fixture" }) }
    catch (error) { void showAlertDialog(String(error)) }
  },
  upstream401: () => createInstanceFetch(`${location.origin}/workspaces/fixture/instance/`)("http://native/api/session"),
}
