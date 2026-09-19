import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { PermissionToolBlock } from "../../../src/components/tool-call/permission-block"
import type { PermissionRequest } from "../../../src/types/permission"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"

const initial: PermissionRequest = { id: "request-one", sessionID: "session-one", action: "shell", resources: ["fixture"] }
const [permission, setPermission] = createSignal<PermissionRequest>(initial)
const [result, setResult] = createSignal("")

render(() => <ConfigProvider><I18nProvider>
  <button id="refresh" onClick={() => setPermission({ ...permission(), metadata: { refreshed: true } })}>refresh</button>
  <button id="next" onClick={() => setPermission({ ...initial, id: "request-two" })}>next</button>
  <PermissionToolBlock permission={permission} active={() => true} submitting={() => false} error={() => null}
    fallbackSessionId={() => "session-one"} renderDiff={() => null}
    onRespond={(_permission, _session, reply, message) => setResult(JSON.stringify({ reply, message }))} />
  <output id="result">{result()}</output>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
