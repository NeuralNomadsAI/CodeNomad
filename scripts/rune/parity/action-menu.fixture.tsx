import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { Dialog } from "@kobalte/core/dialog"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../../../packages/ui/src/components/action-overflow-menu"
import FileRowActions from "../../../packages/ui/src/components/instance/shell/right-panel/FileRowActions"
import AlertDialog from "../../../packages/ui/src/components/alert-dialog"
import { showConfirmDialog, alertDialogState } from "../../../packages/ui/src/stores/alerts"
import { ConfigProvider } from "../../../packages/ui/src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../packages/ui/src/lib/i18n"
import "../../../packages/ui/src/index.css"

const query = new URL(location.href).searchParams
const theme = query.get("theme") === "dark" ? "dark" : "light"
const mode = query.get("case") || "standard"
document.documentElement.setAttribute("data-theme", theme)
const [dialog, setDialog] = createSignal(false)
const [present, setPresent] = createSignal(true)
const [count, setCount] = createSignal(3)
const events: object[] = []
const focused = () => {
  const el = document.activeElement as HTMLElement | null
  return el?.getAttribute("aria-label") || (el?.tagName === "BUTTON" ? el.textContent?.trim() : undefined) || el?.id || el?.tagName
}
const trace = (event: string) => events.push({ event, focus: focused() })
const select = (name: string) => {
  trace(name)
  if (mode?.startsWith("alert-")) void showConfirmDialog("Synthetic selection", {title: "Selection", confirmLabel: "Accept", cancelLabel: "Cancel"})
  else if (["standard", "immediate", "immediate-target"].includes(mode || "")) setDialog(true)
}
const focusTarget = () => {
  const target = mode.startsWith("alert-") ? [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(el => el.textContent?.trim() === "Accept") : document.getElementById("accept") || undefined
  trace(`target:${target?.textContent?.trim() || "missing"}`)
  return target
}
const items = (): ActionOverflowMenuItem[] => {
  const base: ActionOverflowMenuItem[] = [
    { key: "open", label: "Open", description: "Details", selectBeforeClose: mode.includes("immediate"), focusAfterSelect: mode.endsWith("target") ? focusTarget : undefined, onSelect: () => select("select"), onMouseEnter: () => trace("enter"), onMouseLeave: () => trace("leave") },
    { key: "disabled", label: "Disabled", disabled: true, onSelect: () => select("disabled") },
    { key: "checked", label: "Copy", checked: true, onSelect: () => select("checked") },
  ]
  if (mode === "duplicate") base.push({ key: "open", label: "Final", onSelect: () => select("final") })
  return base.slice(0, count() === 3 ? undefined : count())
}
Object.assign(window, { runeActionMenu: { ready: false, state: () => ({ events: [...events], dialog: dialog() || Boolean(alertDialogState()), present: present(), count: count(), focus: focused() }), remove: () => setPresent(false), shrink: () => setCount(0), restore: () => setCount(3) } })

render(() => <ConfigProvider><I18nProvider>
  <div id="frame" style={{ position: "absolute", left: "240px", top: "24px", width: "80px", display: "flex" }}>
    <Show when={present()}>
      <Show when={mode === "row"} fallback={
        <span class="file-row-actions" data-compact="true">
          <ActionOverflowMenu items={items()} label="Project actions" triggerClass="file-row-icon-button" minItems={1}
            onOpenChange={open => trace(`open:${open}`)} onFocusRestored={() => trace("restored")} />
        </span>
      }><span>Long synthetic filename</span><FileRowActions items={items()} label="Project actions" /></Show>
    </Show>
  </div>
  <button id="outside" style={{ position: "absolute", left: "400px", top: "300px" }}>Outside</button>
  <Dialog open={dialog()} onOpenChange={open => { trace(`dialog:open:${open}`); setDialog(open) }}>
    <Dialog.Portal><Dialog.Content aria-label="Selection dialog" onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("cancel")?.focus(); trace("dialog:focus") }}>
      <Dialog.Title>Selection</Dialog.Title><Dialog.CloseButton id="cancel" aria-label="Cancel">Cancel</Dialog.CloseButton><Dialog.CloseButton id="accept" aria-label="Accept">Accept</Dialog.CloseButton>
    </Dialog.Content></Dialog.Portal>
  </Dialog>
  <AlertDialog />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
await preloadLocaleMessages("en")
;(window as any).runeActionMenu.ready = true
