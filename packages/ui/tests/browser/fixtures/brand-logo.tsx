import { render } from "solid-js/web"
import BrandedEmptyState from "../../../src/components/branded-empty-state"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import InstanceTabs from "../../../src/components/instance-tabs"
import { NativeTitlebar } from "../../../src/components/native-titlebar"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { normalizeColorScheme } from "../../../src/lib/theme-scheme"
import { ConfigProvider, setColorSchemePreference, setThemePreference } from "../../../src/stores/preferences"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// A local desktop window as App renders it: title bar and tab bar above the home page or,
// with ?view=session, a session's empty state.
const session = new URLSearchParams(location.search).get("view") === "session"
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ display: "flex", "flex-direction": "column", height: "100vh", background: "var(--surface-canvas)" }}>
    <NativeTitlebar title="CodeNomad" logo menus actions />
    <InstanceTabs tabs={[]} activeTabId={null} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onMoveTab={() => {}} />
    <div class="session-center-column" style={{ flex: "1", display: "flex", "min-height": "0" }}>
      {session
        ? <BrandedEmptyState description="Start a conversation below." />
        : <FolderSelectionView onSelectFolder={() => {}} onSelectExistingInstance={() => {}} />}
    </div>
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
// Keeps the settings in memory, so palette changes apply.
await applyUiSettings({ locale: "en" })
;(window as any).brandFixture = {
  apply: async (id: string) => {
    const scheme = normalizeColorScheme(id)
    await setColorSchemePreference(scheme)
    await setThemePreference(scheme.appearance)
  },
}
