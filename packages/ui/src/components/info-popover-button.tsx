import { Popover } from "@kobalte/core/popover"
import { Info } from "lucide-solid"
import type { JSX } from "solid-js"

/**
 * The shared "i" button: a short accessible name; Enter or Space opens its text, Escape closes it and returns focus
 * to the button. `label` and `children` may be catalogue text, which never passes through the i18n catalogue.
 */
export function InfoPopoverButton(props: { label: string; children: JSX.Element; class?: string }) {
  return (
    <Popover placement="top" gutter={4}>
      <Popover.Trigger type="button" class={`section-info-trigger ${props.class ?? ""}`} aria-label={props.label} title={props.label}>
        <Info class="section-info-icon" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="section-info-tooltip info-popover-content">
          <div class="info-popover-text">{props.children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
