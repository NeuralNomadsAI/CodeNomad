import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import WindowCloseButton from "../../../src/components/window-close-button"
import "../../../src/index.css"

// The production component, providers and styles supply the reference surface.
const fixture = { presses: 0 }
Object.assign(window, { runeWindowClose: fixture })
render(() => <ConfigProvider><I18nProvider>
  <div class="window-shell" style={{ background: "var(--surface-overlay)", width: "max-content" }}>
    <WindowCloseButton onClose={() => fixture.presses++} />
  </div>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
