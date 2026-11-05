import "./remote-server-pairing-api"
import { render } from "solid-js/web"
import { For, Show } from "solid-js"
import { RemoteServerDialog } from "../../../src/components/remote-server-dialog"
import { SavedRemoteServersCard } from "../../../src/components/settings/saved-remote-servers-card"
import { useRemoteServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

// The page's inline script declares a local Electron window that records opened remote windows.
// ?card: the Settings Servers card instead of the bare dialog.
const Harness = () => {
  const { remoteServers, saveServer } = useRemoteServerProfiles()
  return (
    <main style={{ width: "min(900px, 100%)" }}>
      <ul data-testid="servers"><For each={remoteServers()}>{(server) => <li>{server.id} {server.baseUrl}</li>}</For></ul>
      <Show when={new URLSearchParams(location.search).has("card")} fallback={<RemoteServerDialog open onOpenChange={() => undefined} onSubmit={saveServer} />}>
        <SavedRemoteServersCard />
      </Show>
    </main>
  )
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
