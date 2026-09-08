import { render } from "solid-js/web"
import { ConfigProvider, setColorSchemePreference, setThemePreference } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { GeneralSettingsSection } from "../../../src/components/settings/general-settings-section"
import ToolCall from "../../../src/components/tool-call"
import { normalizeColorScheme } from "../../../src/lib/theme-scheme"
import "../../../src/index.css"

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ display: "grid", "grid-template-columns": "260px 1fr 300px", width: "100%", height: "100%", color: "var(--text-primary)" }}>
    <div class="session-sidebar" style={{ padding: "16px" }}>
      <div class="session-item-base session-item-inactive" tabindex="0">Review session</div>
      <div class="session-item-base session-item-active" tabindex="0">Selected session</div>
    </div>
    <div class="session-view" style={{ display: "block", overflow: "auto" }}>
      <div class="message-item-base"><p>Assistant response — readable text on the tool/message surface.</p></div>
      <ToolCall instanceId="appearance-fixture" sessionId="session" messageId="message" toolCall={{
        id: "tool", type: "tool", callID: "call", tool: "bash",
        state: { status: "completed", input: { command: "git status" }, output: "On branch review\nNothing to commit\nWorking tree clean" },
      }} />
      <div style={{ height: "80px" }}><textarea class="prompt-input" aria-label="Fixture composer" value="" /></div>
      <section class="settings-screen-content"><GeneralSettingsSection showStartupState={false} /></section>
    </div>
    <div class="right-panel-accordion">
      <div><button class="right-panel-tab right-panel-tab-active">Active</button><button class="right-panel-tab right-panel-tab-inactive">Inactive</button></div>
      <div class="right-panel-accordion-item"><div class="right-panel-accordion-header-row" tabindex="0">Status</div></div>
      <div class="file-list-item" tabindex="0">File.ts</div>
      <div class="file-list-item file-list-item-active" tabindex="0">Selected.ts</div>
      <button class="file-viewer-toolbar-icon-button" aria-label="File action">↗</button>
      <div class="git-change-section-header" tabindex="0">Changes</div>
      <div class="status-process-card" tabindex="0">Background task</div>
      <button class="settings-nav-button" data-selected="true">General</button>
    </div>
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).appearanceFixture = {
  apply: async (id: string) => {
    const scheme = normalizeColorScheme(id)
    await setColorSchemePreference(scheme)
    await setThemePreference(scheme.appearance)
  },
}
