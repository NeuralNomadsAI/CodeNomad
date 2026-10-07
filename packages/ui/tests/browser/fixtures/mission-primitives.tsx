import { Show } from "solid-js"
import { render } from "solid-js/web"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { MissionReader } from "../../../src/components/mission-reader"
import { getMarkdownTextForRender } from "../../../src/components/markdown"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { initializeClientState } from "../../../src/stores/client-state"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { missionStore } from "../../../src/stores/missions"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

await initializeClientState()
const instance: Instance = { id: "track3", folder: "/fixture", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null }
function Fixture() {
  const { t } = useI18n()
  ;(window as any).track3 = {
    show: async (kind: "overview" | "task" | "report" | "change", itemId?: string) => {
      await missionStore.refresh(instance.id)
      updateMissionProjectView(instance.id, { reader: { missionId: "reader", kind, itemId } })
    },
    locale: (locale: "en" | "he" | "tr") => updatePreferences({ locale }),
    bounded: getMarkdownTextForRender,
    refresh: () => missionStore.refresh(instance.id),
  }
  return <div style={{ display: "flex", height: "700px", gap: "16px" }}>
    <main class="mission-transcript-surface" style={{ flex: "0 0 650px", display: "flex", "flex-direction": "column" }}>
      <button id="reader-trigger">Reader trigger</button>
      <textarea id="draft" />
      <div id="transcript" style={{ height: "70px", overflow: "auto" }}><div style={{ height: "500px" }}>Retained transcript</div></div>
      <Show when={missionProjectView(instance.id).reader}><MissionReader instanceId={instance.id} scope={instance.id} /></Show>
    </main>
    <aside style={{ width: "390px" }}><RightPanel isActive={() => true} t={t} instanceId={instance.id} instance={instance}
      activeSessionId={() => null} activeSession={() => null} isPhoneLayout={() => false}
      rightDrawerWidth={() => 390} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} /></aside>
    <output id="default-budget" style={{ position: "absolute", bottom: "0", width: "300px", height: "50px", overflow: "auto", "overflow-wrap": "anywhere" }}>{getMarkdownTextForRender("x".repeat(11000) + "TAIL_PROOF")}</output>
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
