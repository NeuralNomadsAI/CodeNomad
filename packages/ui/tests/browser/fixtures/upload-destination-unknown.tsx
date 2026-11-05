import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PromptInput instanceId="unknown-source" sessionId="s" instanceFolder="/same" sendBlocked
    onSend={async () => { throw new Error("Unowned composer must not dispatch") }} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {}
