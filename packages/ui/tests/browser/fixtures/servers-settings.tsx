import { render } from "solid-js/web"
import { ConfigProvider, preferencesForBackend, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { PreferencesWindow } from "../../../src/components/preferences-window"
import { ServersSettingsSection } from "../../../src/components/settings/servers-settings-section"
import { useRelayServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { serverEvents } from "../../../src/lib/server-events"
import { sameServerSelection } from "../../../src/lib/native/server-selection-intent"
import { serversManageable } from "../../../src/lib/server-meta"
import "../../../src/index.css"

function Fixture() {
  const config = useConfig(), profiles = useRelayServerProfiles()
  // The fixture shares a document with the owning window's confirmation UI.
  window.electronAPI!.selectServer = async (target, action) => {
    if (action !== "remove") return
    const host = preferencesForBackend("local")
    const current = () => host.preferences().multiBackend === true && serversManageable()
      && host.remoteServers().some(profile => sameServerSelection(profile, target))
    if (!current()) throw new Error("Server selection changed")
    await host.removeRemoteServerProfile(target.id, current)
  }
  Object.assign(window, { serversFixture: { config, profiles, intents: [], dispatch: (events: unknown[]) => (serverEvents as any).dispatchBatch(events) } })
  return <><PreferencesWindow />{
    new URL(location.href).searchParams.has("intent") && <ServersSettingsSection onSelectServer={profile => (window as any).serversFixture.intents.push(profile)} />
  }</>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
