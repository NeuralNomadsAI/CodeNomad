import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import UnifiedPicker from "../../../src/components/unified-picker"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"

function Fixture() {
  const [query, setQuery] = createSignal("needle")
  const [open, setOpen] = createSignal(true)
  return <>
    <input id="query" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
    <button id="close" onClick={() => setOpen(false)}>close</button>
    <UnifiedPicker open={open()} searchQuery={query()} workspaceId="fixture" agents={[]} onSelect={() => {}} onClose={() => setOpen(false)} />
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
