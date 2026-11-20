import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ConfigProvider, preferencesForBackend } from "../../../src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { getServerMeta } from "../../../src/lib/server-meta"
import { useRelayServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import ServerAddField from "../../../src/components/server-add-field"
import { ServerEditor } from "../../../src/components/remote-server-dialog"
import RemoteRestoreView from "../../../src/components/remote-restore-view"
import { RemoteServerBrowser } from "../../../src/components/remote-server-browser"
import type { RemoteRestoreTab } from "../../../src/stores/remote-restore-tabs"
import "../../../src/index.css"

await preferencesForBackend("local").ensureLoaded()
await preloadLocaleMessages("en")
await getServerMeta()
const surface = new URL(location.href).searchParams.get("surface")
function Fixture() {
  const profiles = useRelayServerProfiles()
  const [editor, setEditor] = createSignal(surface === "editor")
  const profile = () => profiles.remoteServers()[0]
  const tab = {
    id: "waiting:a", kind: "remote-restore", retry: async () => {}, remove: () => {},
    snapshot: { backendId: "a", folder: "/fixture" },
  } as RemoteRestoreTab
  Object.assign(window, { secretEntryFixture: { profiles } })
  return <>
    <Show when={surface === "inline" || surface === "dispatch"}><ServerAddField /></Show>
    <Show when={surface === "pairing"}><ServerAddField pairingProfile={profile()} /></Show>
    <Show when={surface === "editor"}>
      <ServerEditor open={editor()} onOpenChange={setEditor} onSubmit={profiles.submitServer} />
    </Show>
    <Show when={surface === "restore"}><RemoteRestoreView tab={tab} /></Show>
    <Show when={surface === "browser"}><RemoteServerBrowser profile={profile()} onBack={() => {}} /></Show>
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
