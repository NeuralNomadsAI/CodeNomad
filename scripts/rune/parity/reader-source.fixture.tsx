import { render } from "solid-js/web"
import { FilesPreviewView } from "../../../packages/ui/src/components/files-preview-view"
import { I18nProvider, preloadLocaleMessages } from "../../../packages/ui/src/lib/i18n"
import { ThemeProvider } from "../../../packages/ui/src/lib/theme"
import { serverApi } from "../../../packages/ui/src/lib/api-client"
import { ConfigProvider, setThemePreference, updatePreferences } from "../../../packages/ui/src/stores/preferences"
import { initializeClientState } from "../../../packages/ui/src/stores/client-state"
import cases from "../../../packages/rune-app/tests/fixtures/reader-content.json"
import "../../../packages/ui/src/index.css"

const query = new URLSearchParams(window.location.search)
const name = query.get("name")
const file = [...cases.documents, ...cases.images].find(file => file.name === name)
if (!file) throw Error(`Unknown reader fixture ${name}`)
const directory = "/synthetic", instanceId = "synthetic-reader"
const target = { kind: "workspace" as const, sessionId: "synthetic", slug: "root", directory, path: file.name }
serverApi.previewWorkspaceFile = async (id, path, root) => {
  if (id !== instanceId || path !== file.name || root !== directory) throw Error("Unexpected Files target")
  return { workspaceId: id, relativePath: path, encoding: "base64", contents: file.base64, version: "v1" }
}
await initializeClientState()
await updatePreferences({ locale: "en" })
await preloadLocaleMessages("en")
await setThemePreference(query.get("theme") === "dark" ? "dark" : "light")
render(() => (
  <ConfigProvider><I18nProvider><ThemeProvider>
    <main style={{ display: "flex", height: "100vh", "flex-direction": "column" }}>
      <FilesPreviewView instanceId={instanceId} target={target} active onClose={() => {}} />
    </main>
  </ThemeProvider></I18nProvider></ConfigProvider>
), document.getElementById("root")!)
