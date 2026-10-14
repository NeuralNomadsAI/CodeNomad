import { render } from "solid-js/web"
import { onMount, onCleanup, createSignal } from "solid-js"
import { ConfigProvider, updatePreferences, useConfig } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { useCommands, type UseCommandsOptions } from "../../../src/lib/hooks/use-commands"
import { serverApi } from "../../../src/lib/api-client"
import CommandPalette from "../../../src/components/command-palette"
import { listenMenuActions } from "../../../src/lib/native/menu-actions"
import AlertDialog from "../../../src/components/alert-dialog"
import "../../../src/index.css"

let config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)

function HelpCommand() {
  const { preferences } = useConfig()
  const { locale } = useI18n()
  // Unrelated callbacks are never exercised; the production hook owns registration/dispatch.
  const options = new Proxy({ preferences, getActiveInstance: () => null, getActiveSessionIdForInstance: () => null,
    handleNewInstanceRequest: () => { (window as any).newInstanceCount = ((window as any).newInstanceCount ?? 0) + 1 },
  }, {
    get: (object, key) => (object as any)[key] ?? (() => {}),
  }) as UseCommandsOptions
  const commands = useCommands(options)
  const [open, setOpen] = createSignal(false)
  onMount(() => {
    onCleanup(listenMenuActions((action) => { if (typeof action === "string") commands.executeMenuCommand(action) }))
    ;(window as any).helpFixture = { setLocale: (value: string) => updatePreferences({ locale: value }), locale }
  })
  return <><button onClick={() => setOpen(true)}>Palette</button><textarea aria-label="Draft">Unsent draft</textarea><CommandPalette id="help-test-palette" open={open()} focusRequest={1} onClose={() => setOpen(false)} commands={commands.commands()} onExecute={commands.executeCommand} /><AlertDialog /></>
}

render(() => <ConfigProvider><I18nProvider><HelpCommand /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
