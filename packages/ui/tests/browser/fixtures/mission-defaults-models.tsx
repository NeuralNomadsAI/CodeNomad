import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { MissionEditor, type MissionEditorAction } from "../../../src/components/mission-editor"
import { MissionPreferences } from "../../../src/components/mission-preferences"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { confirmSettingsDiscard } from "../../../src/stores/settings-dirty-guard"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { getRootClient } from "../../../src/stores/opencode-client"
import "../../../src/index.css"

addInstance({ id: "fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
updateInstance("fixture", { client: getRootClient("fixture") })

function Fixture() {
  const config = useConfig(), { t } = useI18n()
  const [view, setView] = createSignal<"create" | "settings" | "closed">("create")
  const [active, setActive] = createSignal(true)
  const action: MissionEditorAction = { kind: "create" }
  window.missionDefaultsModels = {
    view: setView, active: setActive, text: t, loaded: config.isUiConfigLoaded, generalLoaded: config.isLoaded,
    preferences: config.preferences, update: config.updatePreferences, discard: confirmSettingsDiscard,
  }
  return <main style={{ width: "390px", height: "100vh", overflow: "auto" }}>
    <Show when={view() === "create"}><MissionEditor instanceId="fixture" viewDirectory="/fixture" projectID="project"
      action={action} active={active} onSaved={() => setView("closed")} onCancel={() => setView("closed")} /></Show>
    <Show when={view() === "settings"}><MissionPreferences instanceId="fixture" directory="/fixture" active={active} /></Show>
    <AlertDialog />
  </main>
}

declare global {
  interface Window {
    missionDefaultsModels: {
      view(value: "create" | "settings" | "closed"): void
      active(value: boolean): void
      text(key: string): string
      loaded(): boolean
      generalLoaded(): boolean
      preferences(): ReturnType<ReturnType<typeof useConfig>["preferences"]>
      update: ReturnType<typeof useConfig>["updatePreferences"]
      discard(): Promise<boolean>
    }
  }
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
