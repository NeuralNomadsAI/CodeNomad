import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { serverApi } from "../../../src/lib/api-client"
import { applyMergePatch } from "../../../../server/src/settings/merge-patch"
import "../../../src/index.css"

// Simulated config owner implements the server's merge-patch deletion semantics,
// retains unrelated settings and survives renderer reload without a daemon.
let config: any = JSON.parse(localStorage.getItem("hotkeys-fixture-config") || '{"settings":{"locale":"en","unrelated":"kept"}}')
const patches: unknown[] = []
let failSave = false
serverApi.fetchConfigOwner = async (owner: string) => (owner === "ui" ? config : {}) as any
serverApi.patchConfigOwner = async (_owner: string, patch: any) => {
  if (failSave) throw new Error("Fixture save refused")
  patches.push(patch)
  config = applyMergePatch(config, patch)
  localStorage.setItem("hotkeys-fixture-config", JSON.stringify(config))
  return config
}
serverApi.fetchStateOwner = async () => ({} as any)

const [{ ConfigProvider, updatePreferences }, { I18nProvider }, { HotkeysSettingsSection }, { useAppLifecycle }, { hotkeyLabel, isHotkeyRecording }] = await Promise.all([
  import("../../../src/stores/preferences"), import("../../../src/lib/i18n"),
  import("../../../src/components/settings/hotkeys-settings-section"),
  import("../../../src/lib/hooks/use-app-lifecycle"), import("../../../src/lib/hotkeys"),
])
await updatePreferences({ locale: "en" })
patches.length = 0
let newInstances = 0
const [visible, setVisible] = createSignal(true)
function Fixture() {
  useAppLifecycle({
    setEscapeInDebounce: () => {}, handleNewInstanceRequest: () => { newInstances++ },
    handleCloseActiveTab: async () => {}, handleNewSession: async () => {}, handleCloseSession: async () => {},
    showFolderSelection: () => false, setShowFolderSelection: () => {},
    getActiveInstance: () => ({ id: "fixture" }) as any, getActiveSessionIdForInstance: () => "session",
  })
  return <>
    <button id="outside" title={hotkeyLabel("new-instance")}>Outside target</button>
    <div class="session-cache-pane" aria-hidden="false"><textarea class="prompt-input" aria-label="Prompt" /></div>
    <Show when={visible()}><HotkeysSettingsSection /></Show>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  newInstances: () => newInstances, config: () => config, patches: () => patches,
  isRecording: isHotkeyRecording, setVisible, failSave: (value: boolean) => { failSave = value },
}
