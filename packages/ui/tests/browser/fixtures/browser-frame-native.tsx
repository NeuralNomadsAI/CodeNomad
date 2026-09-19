import { nativeFixture } from "./browser-frame-native-bridge"
import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { BrowserFrame } from "../../../src/components/browser-frame"
import "../../../src/index.css"

function Fixture() {
  const [mounted, setMounted] = createSignal(true)
  const [overlay, setOverlay] = createSignal(false)
  const [error, setError] = createSignal("")
  const query = new URLSearchParams(location.search)
  const guestQuery = query.has("redirect") ? "?redirect" : query.has("hold") ? "?hold" : ""
  const [address, setAddress] = createSignal(`${location.origin}/browser-native-guest${guestQuery}`)
  Object.assign(nativeFixture, { mount: setMounted, overlay: setOverlay, address: setAddress })
  return <>
    <div id="preview" style={{ width: "800px", height: "500px" }}>
      <Show when={mounted()}>
        <BrowserFrame sessionId="fixture-session" title="Preview"
          initialUrl={address()} initialAddress={address()}
          proxyBasePath="" addressMode="url"
          labels={{ back: "Back", refresh: "Refresh", path: "Address", go: "Go", viewport: "Viewport" }}
          onNavigate={async url => url}
          onFrameLocation={url => { nativeFixture.locations.push(url); setAddress(url) }}
          onNavigationError={reason => {
            nativeFixture.errors.push(String(reason))
            setError(String(reason))
            setOverlay(true)
          }} />
      </Show>
    </div>
    <Show when={overlay()}><div role="alertdialog">{error() || "Overlay"}</div></Show>
  </>
}

render(() => <Fixture />, document.getElementById("root")!)
