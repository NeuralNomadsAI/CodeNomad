import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import { NativeTitlebar } from "../../../src/components/native-titlebar"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

// The main window's title bar above its project tab bar, as App renders them in a local desktop window.
render(() => <ConfigProvider><I18nProvider>
  <NativeTitlebar title="CodeNomad" logo menus actions />
  <InstanceTabs tabs={[]} activeTabId={null} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onMoveTab={() => {}} />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).titlebarFixture = true
