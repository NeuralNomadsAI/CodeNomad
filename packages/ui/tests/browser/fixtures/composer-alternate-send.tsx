import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { getRootClient } from "../../../src/stores/opencode-client"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// The real composer with a running or idle session; sends record their delivery.
const instanceId = "alternate-send"
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: getRootClient(instanceId) })
setActiveInstanceId(instanceId)
const session = { id: "ses_main", instanceId, title: "Main", parentId: null, agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, status: "working", time: { created: 1, updated: 1 } } as Session
setSessions(new Map([[instanceId, new Map([[session.id, session]])]]))
const [busy, setBusy] = createSignal(true)
const sends: Array<{ prompt: string; delivery: string }> = []
await applyUiSettings({ locale: "en", followUpBehavior: "steer" })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PromptInput instanceId={instanceId} instanceFolder="/fixture" sessionId={session.id} isActive={true} isSessionBusy={busy()}
    onSend={async (prompt, _attachments, delivery) => { sends.push({ prompt, delivery }) }} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { sends, setBusy, setPreferences: updatePreferences }
