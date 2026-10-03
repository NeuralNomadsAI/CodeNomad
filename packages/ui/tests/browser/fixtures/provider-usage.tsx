import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import ProviderUsagePanel from "../../../src/components/session/provider-usage-panel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

const [scope, setScope] = createSignal({ instanceId: "first", sessionId: "session-a", directory: "/repo", providerId: "openai", modelId: "gpt-5" })
const [active, setActive] = createSignal(true)
const [mounted, setMounted] = createSignal(true)
;(window as any).usageFixture = {
  select: (next: Partial<ReturnType<typeof scope>>) => setScope(current => ({ ...current, ...next })),
  active: setActive, mounted: setMounted,
  event: (type: string, instanceId = scope().instanceId, directory = scope().directory) => (serverEvents as any).dispatchBatch([{
    type: "instance.event", instanceId, event: { type, id: "event", created: Date.now(), data: {}, location: { directory } },
  }]),
  connection: (status: string, generation = 1, instanceId = scope().instanceId) =>
    (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId, status, generation }]),
  transport: (status: string) => (serverEvents as any).emitTransportStatus(status),
}
render(() => <ConfigProvider><I18nProvider><Show when={mounted()}>
  <div data-usage><ProviderUsagePanel instanceId={scope().instanceId} sessionId={scope().sessionId} directory={scope().directory}
    providerId={scope().providerId} modelId={scope().modelId} active={active()} /></div>
</Show></I18nProvider></ConfigProvider>, document.getElementById("root")!)
