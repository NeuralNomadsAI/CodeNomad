import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ShellOutputDialog } from "../../../src/components/shell-output-dialog"
import { createBackendClient, registerBackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { activeInstanceId, setActiveInstanceId } from "../../../src/stores/instances"
import OpenCodeSetup from "../../../src/components/opencode-setup"
import { OpenCodeSettingsSection } from "../../../src/components/settings/opencode-settings-section"
import { ConfigProvider, serverSettings, setThemePreference, updatePreferences, updateLastUsedBinary } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { openOpenCodeSetup, refreshOpenCodeSetup, invalidateOpenCodeSetup } from "../../../src/stores/opencode-setup"
import { createInstanceFetch } from "../../../src/lib/sdk-manager"
import AlertDialog from "../../../src/components/alert-dialog"
import { getToastHistory } from "../../../src/lib/notifications"
import { showAlertDialog, showConfirmDialog, showPromptDialog } from "../../../src/stores/alerts"
import "../../../src/index.css"
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
serverApi.getOpenCodeLoginStart = async () => ({ state: "off" })
let resumed = 0
let replacementResult: boolean | string | null | undefined
const params = new URLSearchParams(location.search)
const settings = params.has("settings")
const [shellOpen, setShellOpen] = createSignal(false)
const shellReads: { owner: string; url: string }[] = []
let releaseShell: (() => void) | undefined
if (params.has("shell")) {
  for (const owner of ["A", "B"]) {
    const client = createBackendClient({ id: `logs${owner}`, baseUrl: `${location.origin}/${owner}`, fetcher: async input => {
      shellReads.push({ owner, url: input instanceof Request ? input.url : String(input) })
      await new Promise<void>(resolve => { releaseShell = resolve })
      return Response.json({ location: { directory: "/repo/A" }, data: { output: '\u001b[31mA <b>literal</b>\u001b[0m\n', cursor: 1, size: 1, truncated: false } })
    } })
    registerBackendClient(client)
    backendEvents.attach(client.id, client.events)
  }
  setActiveInstanceId("logsA~same")
}
render(() => <ConfigProvider><ThemeProvider><I18nProvider>
  {settings && <main style={{ padding: "24px", "max-width": "900px" }}><OpenCodeSettingsSection /></main>}
  {params.has("shell") && <aside>
    <button onClick={() => setShellOpen(true)}>Open shell A</button>
    <button onClick={() => setActiveInstanceId("logsB~same")}>Navigate B</button><span data-selected>{activeInstanceId()}</span>
    <ShellOutputDialog open={shellOpen()} instanceId="logsA~same" directory="/repo/A" shell={{ id: "s", command: "echo A" } as any} onClose={() => setShellOpen(false)} />
  </aside>}
   <OpenCodeSetup automatic={!settings} />
   <AlertDialog />
</I18nProvider></ThemeProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: params.get("locale") === "fr" ? "fr" : "en" })
await setThemePreference(params.get("theme") === "dark" ? "dark" : "light")
;(window as any).fixture = {
  open: () => openOpenCodeSetup(async () => { resumed++ }), resumed: () => resumed,
  reopen: () => openOpenCodeSetup(),
   selectedBinary: () => serverSettings().opencodeBinary,
   selectBinary: updateLastUsedBinary,
  refresh: refreshOpenCodeSetup,
  invalidate: invalidateOpenCodeSetup,
  notifications: getToastHistory,
  replaceDialog: (type: "alert" | "confirm" | "prompt") => {
    replacementResult = undefined
    if (type === "alert") showAlertDialog("Fixture execution error", { title: "Fixture replacement", variant: "error" })
    if (type === "confirm") void showConfirmDialog("Fixture replacement confirmation", { title: "Fixture replacement" }).then(value => { replacementResult = value })
    if (type === "prompt") void showPromptDialog("Fixture replacement prompt", { title: "Fixture replacement" }).then(value => { replacementResult = value })
  },
  replacementResult: () => replacementResult,
  shellReads,
  releaseShell: () => releaseShell?.(),
  unsupported: () => createInstanceFetch(`${location.origin}/workspaces/w/instance/`)(`${location.origin}/workspaces/w/instance/api/session/s/prompt`,
    { method: "POST", body: "{}" }).then(response => response.status),
}
