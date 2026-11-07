import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import RemoteServerBrowser from "../../../src/components/remote-server-browser"
import ServerAddField from "../../../src/components/server-add-field"
import { RemoteServerDialog } from "../../../src/components/remote-server-dialog"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
const profile = { id: "box", name: `Box ${"long-server-name-".repeat(12)}`, baseUrl: query.has("tunnel") ? "https://box.opentunnel.xyz" : "https://box.example", skipTlsVerify: false, createdAt: "", updatedAt: "" }
function Fixture() {
  const [selected, setSelected] = createSignal("")
  return <div style={{ width: "100%", "max-width": "480px" }}>
    {query.has("add") ? <ServerAddField /> : query.has("dialog")
      ? <RemoteServerDialog open onOpenChange={() => {}} initial={profile} onSubmit={async () => {}} />
      : <RemoteServerBrowser profile={profile} onBack={() => {}} onSelect={setSelected} />}
    <output>{selected()}</output>
    <input aria-label="Other surface" />
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
