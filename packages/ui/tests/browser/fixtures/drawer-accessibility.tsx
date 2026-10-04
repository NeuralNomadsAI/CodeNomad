import { batch, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import Modal from "@suid/material/Modal"
import { ThemeProvider, createTheme } from "@suid/material/styles"
import { HostedDrawer } from "../../../src/components/instance/shell/HostedDrawer"
import "../../../src/index.css"

declare global {
  interface Window {
    drawerAccessibility: { direction(rtl: boolean): void; mounted(value: boolean): void }
  }
}

function Fixture() {
  const [host, setHost] = createSignal<HTMLDivElement>()
  const [rtl, setRTL] = createSignal(false)
  const [mounted, setMounted] = createSignal(true)
  const [left, setLeft] = createSignal(false), [right, setRight] = createSignal(false)
  const [adjacent, setAdjacent] = createSignal(false)
  const [actions, setActions] = createSignal(0)
  window.drawerAccessibility = {
    direction(value) { document.documentElement.dir = value ? "rtl" : "ltr"; setRTL(value) },
    mounted(value) { batch(() => { setLeft(false); setRight(false); setAdjacent(false); setMounted(value) }) },
  }
  const switchTo = (side: "left" | "right") => batch(() => { setLeft(side === "left"); setRight(side === "right") })
  const content = (side: "left" | "right") => <div style={{ padding: "24px" }}>
    <button onClick={() => setActions(n => n + 1)}>{side} action</button>
    <button onClick={() => switchTo(side === "left" ? "right" : "left")}>Switch to {side === "left" ? "right" : "left"}</button>
    <button onClick={() => setAdjacent(true)}>Open adjacent</button>
    <button onClick={() => side === "left" ? setLeft(false) : setRight(false)}>Close {side}</button>
  </div>
  return <ThemeProvider theme={createTheme({ direction: rtl() ? "rtl" : "ltr" })}>
    <button data-outside>Outside host</button>
    <div data-outside-hidden aria-hidden="true"><button>Outside hidden</button></div>
    <div ref={setHost} class="session-shell-panels" data-host
      style={{ position: "relative", width: "320px", height: "420px", "margin-top": "40px", "margin-inline": "24px", overflow: "auto" }}>
      <div data-background><button onClick={() => setLeft(true)}>Open left</button><button onClick={() => setRight(true)}>Open right</button></div>
      <div data-previously-hidden aria-hidden="true"><button>Previously hidden</button></div>
      <Show when={mounted()}>
        <HostedDrawer container={host()} class="session-floating-drawer" anchor={rtl() ? "right" : "left"}
          open={left()} onClose={() => setLeft(false)}>{content("left")}</HostedDrawer>
        <HostedDrawer container={host()} class="session-floating-drawer" anchor={rtl() ? "left" : "right"}
          open={right()} onClose={() => setRight(false)}>{content("right")}</HostedDrawer>
        {/* Same-host adjacent modal: real SUID modal authority, no test hiding implementation. */}
        <Modal container={host()} disablePortal open={adjacent()} onClose={() => setAdjacent(false)}
          sx={{ position: "absolute", zIndex: 70 }}>
          <div role="dialog" aria-label="Adjacent modal" style={{ position: "absolute", inset: "40px", background: "white" }}>
            <button onClick={() => setActions(n => n + 1)}>Adjacent action</button>
            <button onClick={() => setAdjacent(false)}>Close adjacent</button>
          </div>
        </Modal>
      </Show>
    </div>
    <output data-actions>{actions()}</output>
  </ThemeProvider>
}

render(() => <Fixture />, document.getElementById("root")!)
