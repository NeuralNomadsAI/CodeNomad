import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { serverApi } from "../../../src/lib/api-client"
import { applyMergePatch } from "../../../../server/src/settings/merge-patch"
import CommandPalette from "../../../src/components/command-palette"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { alertDialogState } from "../../../src/stores/alerts"
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

const [{ ConfigProvider, updatePreferences, useConfig }, { I18nProvider }, { HotkeysSettingsSection }, { useAppLifecycle }, { hotkeyLabel, isHotkeyRecording }, { useCommands }, { keyboardRegistry }, { setSessions }] = await Promise.all([
  import("../../../src/stores/preferences"), import("../../../src/lib/i18n"),
  import("../../../src/components/settings/hotkeys-settings-section"),
  import("../../../src/lib/hooks/use-app-lifecycle"), import("../../../src/lib/hotkeys"),
  import("../../../src/lib/hooks/use-commands"), import("../../../src/lib/keyboard-registry"), import("../../../src/stores/session-state"),
])
await updatePreferences({ locale: "en" })
patches.length = 0
let newInstances = 0
let temporaryInstances = 0, redos = 0
const [visible, setVisible] = createSignal(true)
const [hasInstance, setHasInstance] = createSignal(true)
const [hasClient, setHasClient] = createSignal(true)
const [sessionId, setSessionId] = createSignal<string | null>("session")
const [paletteOpen, setPaletteOpen] = createSignal(false)
const instance = { id: "fixture", client: { session: { revert: { clear: async () => { redos++ } } } } }
function Fixture() {
  const config = useConfig()
  const actions = {
    handleNewInstanceRequest: () => { newInstances++ },
    handleNewTemporaryInstance: async () => { temporaryInstances++ },
    handleCloseActiveTab: async () => {}, handleNewSession: async () => {}, handleCloseSession: async () => {},
    getActiveInstance: () => hasInstance() ? (hasClient() ? instance : { ...instance, client: null }) as any : null, getActiveSessionIdForInstance: sessionId,
  }
  const commands = useCommands({ ...config, ...actions })
  useAppLifecycle({
    ...actions, commands: commands.commands, executeCommand: commands.executeCommand,
    setEscapeInDebounce: () => {},
  })
  ;(window as any).commandFixture = {
    commands: () => commands.commands().map(({ id, shortcutId }) => ({ id, shortcutId })),
    registered: (id: string) => Boolean(keyboardRegistry.get(id)),
    preferences: config.preferences,
    executeMenuCommand: commands.executeMenuCommand,
    run: (id: string) => commands.commandRegistry.get(id)?.action(),
    alert: alertDialogState,
  }
  return <>
    <button id="outside" title={hotkeyLabel("new-instance")}>Outside target</button>
    <button onClick={() => setPaletteOpen(true)}>Palette</button>
    <CommandPalette id="fixture-palette" open={paletteOpen()} focusRequest={0} onClose={() => setPaletteOpen(false)} commands={commands.commands()} onExecute={commands.executeCommand} />
    <div class="session-cache-pane" aria-hidden="false"><textarea class="prompt-input" aria-label="Prompt" /></div>
    <Show when={visible()}><HotkeysSettingsSection /></Show>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  newInstances: () => newInstances, config: () => config, patches: () => patches,
  isRecording: isHotkeyRecording, setVisible, failSave: (value: boolean) => { failSave = value },
  temporaryInstances: () => temporaryInstances, redos: () => redos, setHasInstance, setHasClient, setSessionId,
  setMessages: (messages: { id: string; role: "user" | "assistant"; created?: number }[]) => {
    const store = messageStoreBus.getOrCreate("fixture")
    store.hydrateMessages("session",
      messages.map(message => ({ id: message.id, sessionId: "session", role: message.role, status: "complete" })),
      messages.map(message => ({ id: message.id, sessionID: "session", role: message.role, time: { created: message.created } })) as any)
  },
  setStoreRevert: (messageID?: string) => messageStoreBus.getOrCreate("fixture").setSessionRevert("session", messageID ? { messageID } : null),
  setRevert: (enabled: boolean) => setSessions(previous => new Map(previous).set("fixture", new Map([
    ["session", { id: "session", revert: enabled ? { messageID: "previous" } : undefined } as any],
  ]))),
}
