import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { PreferencesWindow } from "../../../src/components/preferences-window"
import "../../../src/index.css"

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PreferencesWindow />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
