import { render } from "solid-js/web"
import IconButton from "@suid/material/IconButton"
import Switch from "@suid/material/Switch"
import { Search } from "lucide-solid"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

// Real SUID controls under the app theme, as in the session header and status panel.
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ display: "flex", gap: "16px", padding: "24px", "align-items": "center" }}>
    <button type="button" id="before">Before</button>
    <IconButton class="icon-toggle" color="inherit" size="small" aria-label="Header action">
      <Search class="w-5 h-5" aria-hidden="true" />
    </IconButton>
    <Switch size="small" inputProps={{ "aria-label": "Fixture switch" }} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).iconButtonFixture = true
