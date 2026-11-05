import "./remote-server-pairing-api"
import { render } from "solid-js/web"
import { For } from "solid-js"
import { RemoteServerDialog } from "../../../src/components/remote-server-dialog"
import { useRemoteServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

// The page's inline script declares a local Electron window that records opened remote windows.
const Harness = () => {
  const { remoteServers, saveServer } = useRemoteServerProfiles()
  return (
    <main style={{ width: "min(900px, 100%)" }}>
      <ul data-testid="servers"><For each={remoteServers()}>{(server) => <li>{server.id} {server.baseUrl}</li>}</For></ul>
      <RemoteServerDialog open onOpenChange={() => undefined} onSubmit={saveServer} />
    </main>
  )
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
