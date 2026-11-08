import { Tooltip } from "@kobalte/core/tooltip"
import { Info } from "lucide-solid"
import { createSignal, type Component } from "solid-js"
import { openExternalUrl } from "../../lib/external-url"
import { helpUrl, type HelpDestination } from "../../lib/help-url"
import { useI18n } from "../../lib/i18n"
import { showAlertDialog } from "../../stores/alerts"

/**
 * Secondary explanation kept out of the row: an "i" that reveals the text on
 * hover or keyboard focus, and on tap for touch screens (which have neither).
 * A span keeps it out of a row label's native control association. With help,
 * it acts as a link; activation never changes the row or navigates this window.
 */
export const SettingsInfoTip: Component<{ text: string; help?: HelpDestination }> = (props) => {
  const { t, locale } = useI18n()
  const [open, setOpen] = createSignal(false)
  const openHelp = async () => {
    const help = props.help
    if (!help) return
    setOpen(false)
    if (!await openExternalUrl(helpUrl(locale(), help.page, help.anchor), "help")) {
      showAlertDialog(t("commands.openHelp.failed"), { title: t("commands.openHelp.label"), variant: "error" })
    }
  }
  // A tap's target state, decided at press time: the focus a tap gives the trigger opens it before the click.
  let tapped: boolean | undefined
  return (
    <Tooltip open={open()} onOpenChange={setOpen} openDelay={200} gutter={4} placement="top">
      <Tooltip.Trigger as="span" tabindex="0" role={props.help ? "link" : "img"} class="settings-info-tip" aria-label={props.text}
        onPointerDown={(event: PointerEvent) => {
          if (props.help) event.stopPropagation()
          tapped = event.pointerType === "mouse" ? undefined : !open()
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (!props.help) return
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            void openHelp()
          }
        }}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
          if (props.help) {
            event.stopPropagation()
            tapped = undefined
            void openHelp()
            return
          }
          // The trigger hides its tooltip on every click; a tap then applies its own state.
          const next = tapped
          tapped = undefined
          if (next !== undefined) queueMicrotask(() => setOpen(next))
        }}>
        <Info aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="section-info-tooltip">{props.text}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  )
}
