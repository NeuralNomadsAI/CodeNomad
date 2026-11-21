import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import PromptAsideWindow from "../../../src/components/prompt-input/PromptAsideWindow"
import { WorkspaceFileView } from "../../../src/components/workspace-file-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { backends, createRemoteBackendClient, localBackend, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import type { PromptAsideController } from "../../../src/components/prompt-input/usePromptAside"
import "../../../src/index.css"

const html = '<img src="/api/media-probe.png" alt="root"><img src="./media-probe.png" alt="dot"><img src="../media-probe.png" alt="parent">'
const remote = createRemoteBackendClient("views")
;(backends as Map<string, BackendClient>).set("views", remote)
backendEvents.attach("views", remote.events)
localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
for (const backend of [localBackend, remote]) backend.api.previewWorkspaceFile = async () => ({ contents: html, encoding: "utf8" }) as any
const [visible, setVisible] = createSignal(true)
const [owner, setOwner] = createSignal("views~same")
function Views() {
  const [question, setQuestion] = createSignal("")
  const controller: PromptAsideController = {
    instanceId: owner, open: () => true, question, setQuestion, answer: () => html,
    error: () => "", pending: () => false, launch: () => true, ask: async () => {}, cancel: () => {}, close: () => {},
  }
  return <>
    <PromptAsideWindow id="media-aside" controller={controller} />
    <WorkspaceFileView instanceId={owner()} active target={{ sessionId: "session", slug: "main", directory: "/project", path: "readme.md" }} onClose={() => {}} />
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}><Views /></Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).views = { unmount: () => setVisible(false), remount: () => setVisible(true), local: () => setOwner("same") }
