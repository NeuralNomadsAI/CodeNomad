import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { getRootClient } from "../../../src/stores/opencode-client"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import { addToHistory } from "../../../src/stores/message-history"
import type { Session } from "../../../src/types/session"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const instanceId = "history-focus"
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: getRootClient(instanceId) })
setActiveInstanceId(instanceId)
setSessions(new Map([[instanceId, new Map(["first", "second"].map(id => [id, {
  id, instanceId, title: id, parentId: null, agent: "build", status: "idle",
  model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as Session]))]]))
await applyUiSettings({ locale: "en" })
await addToHistory("/fixture", "previous message")
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PromptInput instanceId={instanceId} instanceFolder="/fixture" sessionId="first" isActive={true} onSend={async () => {}} />
  <PromptInput instanceId={instanceId} instanceFolder="/fixture" sessionId="second" isActive={false} onSend={async () => {}} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = true
