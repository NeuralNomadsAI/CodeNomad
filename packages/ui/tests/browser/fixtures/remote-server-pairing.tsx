import "./remote-server-pairing-api"
import { render } from "solid-js/web"
import { For } from "solid-js"
import ServerAddField from "../../../src/components/server-add-field"
import { useRemoteServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

// The page's inline script declares a native Preferences window (no project tabs) that records opened remote windows.
const Harness = () => {
  const { remoteServers } = useRemoteServerProfiles()
  return (
    <main style={{ width: "min(900px, 100%)" }}>
      <ul data-testid="servers"><For each={remoteServers()}>{(server) => <li>{server.id} {server.baseUrl}</li>}</For></ul>
      <ServerAddField open={false} />
    </main>
  )
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
