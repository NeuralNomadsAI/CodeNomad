import { render } from "solid-js/web"
import { RemoteAccessSettingsSection } from "../../../src/components/settings/remote-access-settings-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

// ?mode=all models a server already listening beyond localhost.
const listeningMode = new URLSearchParams(location.search).get("mode") === "all" ? "all" : "local"
serverApi.fetchServerMeta = async () => ({
  localUrl: "http://127.0.0.1:9899", eventsUrl: "/api/events", host: listeningMode === "all" ? "0.0.0.0" : "127.0.0.1",
  listeningMode, localPort: 9899, hostLabel: "fixture", workspaceRoot: "/fixture", addresses: [],
}) as any
serverApi.fetchAuthStatus = async () => ({ authenticated: true, username: "codenomad", passwordUserProvided: false })

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ width: "min(900px, 100%)" }}><RemoteAccessSettingsSection /></main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
