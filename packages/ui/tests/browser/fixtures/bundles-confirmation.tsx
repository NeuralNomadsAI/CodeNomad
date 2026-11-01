import { createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { useApi4Channel } from "../../../src/components/panel-extensions/api4-channel"
import { PANEL_EXTENSION_SANDBOX, panelExtensionDocument } from "../../../src/components/panel-extensions/frame-document"
import { acknowledgeBundlesRequest, BundlesConfirmationView } from "../../../src/components/panel-extensions/bundles-confirmation"
import { BundlesLifecycle, type BundlesConfirmation, type BundlesMount, type BundlesTarget } from "../../../../server/src/panel-extensions/bundles-lifecycle"
import { NativeMutationAdmission } from "../../../../server/src/opencode/native-mutation-authority"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

await applyUiSettings({ locale: "en" })
addInstance({ id: "lifecycle", folder: "/fixture", status: "ready", client: {} as any, port: 0, pid: 0, proxyPath: "" })
setActiveInstanceId("lifecycle")
const lifecycle = new BundlesLifecycle(), log: string[] = []
const [view, setView] = createSignal<{ value: BundlesConfirmation; owner: BundlesMount }>()
const [generation, setGeneration] = createSignal(1)
let dispatched = 0, selected = "ses_one", held: (() => void) | undefined, pause = false, failed = false
let target: BundlesTarget = { instance: "lifecycle", session: selected, location: "/fixture", connection: "generation1",
  integration: "blender", scope: "global", range: "^1.0.0", documentDigest: "private-document-digest" }
const author = `<p id="ready"></p><script>
  window.results=[]; window.changes=[]; window.messages=[];
  codenomad.onContext(() => document.querySelector('#ready').textContent='ready');
  codenomad.bundles.onChanged(value => changes.push(value));
  window.ask = () => codenomad.bundles.state().then(value => { results.push(value); return value; });
  addEventListener('message', event => { if(event.data?.type==='codenomad:init') {
    event.ports[0].addEventListener('message', event => messages.push(event.data)); event.ports[0].start();
  }});
</script>`
const drivers: Array<{ armed: boolean; owner: BundlesMount; revoke(): void }> = []
function Frame(props: { index: number }) {
  let frame!: HTMLIFrameElement, port: MessagePort | undefined, authenticated = false, disposed = false
  const abort = new AbortController(), consent = new AbortController(), handshake = crypto.randomUUID()
  const send = (value: unknown) => { if (!disposed && authenticated) port?.postMessage(value) }
  const authority = { signal: consent.signal, assertCurrent() { consent.signal.throwIfAborted(); abort.signal.throwIfAborted() },
    async revalidate() { this.assertCurrent() } }
  const owner = lifecycle.mount({ extension: `fixture.extension${props.index}`, digest: "a".repeat(64), authority, signal: abort.signal,
    changed(event) { log.push(`terminal:${event.kind === "request" ? event.outcome : "state"}`); send({ type: "bundles:changed", ...event }) },
    show(value) { if (value) { log.push("view"); setView({ value, owner }) } else if (view()?.owner === owner) setView(undefined) } })
  const channel = useApi4Channel({ instanceId: "lifecycle", id: owner.extension, digest: owner.digest, sessionId: selected,
    permissions: ["bundles.read", "bundles.manage"], send, mounted: () => !disposed,
    host: { activeSessionId: () => selected, promptInputApi: () => null, isPhoneLayout: () => false, closePanel() {} } })
  const driver = { owner, armed: false, revoke() { consent.abort() } }; drivers[props.index] = driver
  onCleanup(() => { disposed = true; abort.abort(); channel.dispose(); port?.close() })
  const loaded = () => {
    if (port) { disposed = true; abort.abort(); channel.dispose(); port.close(); return }
    const pair = new MessageChannel(); port = pair.port1
    port.onmessage = event => {
      if (!authenticated && event.data?.type === "ready" && event.data.handshake === handshake) {
        authenticated = true; send({ type: "context", context: { apiVersion: 4, sessionId: selected, locale: "en", appearance: "dark" } }); return
      }
      if (!authenticated || disposed) return
      // Parent-fixture-only driver. The shipped dispatcher and injected object keep manage absent.
      if (driver.armed && event.data?.capability === "bundles" && event.data?.method === "state") {
        driver.armed = false
        acknowledgeBundlesRequest(lifecycle, owner, async signal => {
          const captured = { ...target }
          if (pause) await new Promise<void>(resolve => { held = resolve })
          signal.throwIfAborted()
          return { target: captured, display: { action: "attach", integration: "Blender", scope: "global", version: "1.0.0", conversation: "One", document: "Scene.blend" },
            async readTarget() { return { ...target } }, async dispatch(authority, submitted) {
              const admission = new NativeMutationAdmission(authority)
              await admission.revalidate(); if (failed) throw new Error("PRIVATE_ERROR_SENTINEL")
              admission.admit(); submitted(); dispatched++
            } }
        }, ack => { log.push("ack"); send({ type: "api4:result", id: event.data.id, result: ack }) })
      } else void channel(event.data)
    }
    frame.contentWindow?.postMessage({ type: "codenomad:init" }, "*", [pair.port2])
  }
  return <iframe ref={frame} title={`Extension ${props.index}`} sandbox={PANEL_EXTENSION_SANDBOX}
    srcdoc={panelExtensionDocument(author, handshake, 4, ["session.context", "bundles.read", "bundles.manage"])} onLoad={loaded} />
}
function Fixture() {
  return <>
    <Show when={generation()} keyed>{_generation => <><Frame index={0} /><Frame index={1} /></>}</Show>
    <Show when={view()} keyed>{current => <BundlesConfirmationView view={current.value}
      displayed={plan => lifecycle.displayed(current.owner, plan)} confirm={plan => lifecycle.confirm(current.owner, plan)}
      cancel={plan => lifecycle.cancel(current.owner, plan)} />}</Show>
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  arm(index = 0) { drivers[index]!.armed = true },
  snapshot() { return { dispatched, log: [...log], pending: Boolean(view()), planID: view()?.value.planID } },
  revoke(index = 0) { drivers[index]!.revoke() },
  remount() { setGeneration(value => value + 1) },
  navigate() { selected = "ses_other"; setGeneration(value => value + 1); selected = "ses_one"; setGeneration(value => value + 1) },
  mutateTarget() { target = { ...target, documentDigest: "changed-document-digest" } },
  pause(value: boolean) { pause = value }, release() { pause = false; held?.(); held = undefined },
  fail(value: boolean) { failed = value },
  event() { (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: "lifecycle", event: { type: "plugin.updated", data: {} } }]) },
}
