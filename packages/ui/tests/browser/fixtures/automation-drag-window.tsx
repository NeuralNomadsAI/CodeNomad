import { render } from "solid-js/web"
import { OutputWindow } from "../../../src/components/output-window"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import "../../../src/index.css"

render(() => <ConfigProvider><I18nProvider>
  <style>{`.output-window { position: fixed; inset: 310px auto auto 120px; transform: none; width: 360px; }`}</style>
  <div role="region" aria-label="Drop zone" style={{ position: "fixed", left: "16px", top: "16px", width: "48px", height: "48px" }} />
  <OutputWindow id="diagnostics" open title="Diagnostics" onClose={() => {}}>Output</OutputWindow>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
