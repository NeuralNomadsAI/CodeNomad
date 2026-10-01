import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { InfoSettingsSection } from "../../../src/components/settings/info-settings-section"
import "../../../src/index.css"

render(() => <ConfigProvider><I18nProvider><InfoSettingsSection /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
