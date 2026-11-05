import { render } from "solid-js/web"
import { WorkspaceFileView } from "../../../src/components/workspace-file-view"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, instances, updateInstance } from "../../../src/stores/instances"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const id = "media-workspace-owner"
const text = "![resident local image](http://127.0.0.1:4333/project-image.png)"
const delayed = window.location.search.includes("delayed")
let reads = 0, explicitReads = 0, release = () => {}
const gate = new Promise<void>(resolve => { release = resolve })
serverApi.previewWorkspaceFile = async () => {
  reads++
  if (instances().get(id)?.binding?.serverId) explicitReads++
  if (delayed) await gate
  return { contents: text, encoding: "utf8" } as any
}
addInstance({ id, folder: "/held", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
await applyUiSettings({})
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <section id="workspace-caller"><WorkspaceFileView instanceId={id}
    target={{ kind: "workspace", directory: "/held", path: "readme.md", sessionId: "same" }} active onClose={() => {}} /></section>
  {!delayed && <section id="owner-control"><Markdown part={{ type: "text", text }} instanceId={id} escapeRawHtml /></section>}
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).workspaceReview = {
  rebind: () => updateInstance(id, { binding: { serverId: "explicit-loopback", directory: "/held" } }),
  reads: () => reads, explicitReads: () => explicitReads, release,
}
