import { render } from "solid-js/web"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { PreferencesWindow } from "../../../src/components/preferences-window"
import { ServersSettingsSection } from "../../../src/components/settings/servers-settings-section"
import { useRelayServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

function Fixture() {
  const config = useConfig(), profiles = useRelayServerProfiles()
  Object.assign(window, { serversFixture: { config, profiles, intents: [], dispatch: (events: unknown[]) => (serverEvents as any).dispatchBatch(events) } })
  return <><PreferencesWindow />{
    new URL(location.href).searchParams.has("intent") && <ServersSettingsSection onSelectServer={profile => (window as any).serversFixture.intents.push(profile)} />
  }</>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
