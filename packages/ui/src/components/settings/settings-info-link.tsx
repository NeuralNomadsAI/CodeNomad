import { Popover } from "@kobalte/core/popover"
import { Info } from "lucide-solid"
import { createSignal, type Component } from "solid-js"

/**
 * An "i" whose one-sentence explanation ends with a link. Tooltips cannot hold a
 * focusable link, so this opens a small popover on click, Enter or Space; Escape
 * and outside interaction close it. It looks like SettingsInfoTip.
 */
export const SettingsInfoLink: Component<{ label: string; text: string; link: string; onLink: () => void }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="top" gutter={4}>
      <Popover.Trigger as="button" type="button" class="settings-info-tip settings-info-link" aria-label={props.label}>
        <Info aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="section-info-tooltip settings-info-link-content" aria-label={props.label}>
          <Popover.Description as="span">{props.text}</Popover.Description>{" "}
          <button type="button" class="settings-info-link-action" onClick={() => { setOpen(false); props.onLink() }}>{props.link}</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
