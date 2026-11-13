import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { WorkspaceFileView } from "../../../src/components/workspace-file-view"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"


serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
serverApi.fetchStateOwner = async () => ({}) as any
let file = "flowchart TD\n A[File] --> B[Preview]"
let reads = 0
serverApi.previewWorkspaceFile = async () => { reads++; return { contents: file, encoding: "utf8" } as any }
const [text, setText] = createSignal("Initial text")
const [dark, setDark] = createSignal(false)
const [streaming, setStreaming] = createSignal(false)
const [limit, setLimit] = createSignal<number>()
const [mounted, setMounted] = createSignal(true)
const [fileView, setFileView] = createSignal(false)
const [path, setPath] = createSignal("example.mmd")
const dispose = render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ padding: "16px", "max-width": "1000px", height: "850px", display: "flex", "flex-direction": "column" }}><Show when={mounted()}>
    <Show when={fileView()} fallback={<Markdown part={{ id: "mermaid-message", type: "text", text: text() }} isDark={dark()} streaming={streaming()} renderLimit={limit()} />}>
      <WorkspaceFileView instanceId="mermaid" target={{ sessionId: "session", slug: "root", directory: "/repo", path: path() }} active onClose={() => setFileView(false)} />
    </Show>
  </Show></main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
void updatePreferences({ locale: "en" })
;(window as any).fixture = { setText, setDark, setStreaming, setLimit, setMounted, setFileView, dispose,
  file(value: string) { file = value; setPath(value.includes("Invalid") ? "invalid.mmd" : "example.mmd"); setFileView(true) },
  reads: () => reads,
}
