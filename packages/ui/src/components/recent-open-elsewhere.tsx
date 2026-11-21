import { Show, createSignal, type ParentProps } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"

export default function RecentOpenElsewhere(props: { label?: string }) {
  return <Show when={props.label}>
    <span class="status-dot ready inline-block shrink-0 pointer-events-none" aria-hidden="true" />
  </Show>
}

export function RecentOpenElsewhereTooltip(props: ParentProps<{ label?: string }>) {
  const [open, setOpen] = createSignal(false)
  return <Tooltip open={Boolean(props.label && open())} onOpenChange={setOpen} placement="top" gutter={4}>
    {props.children}
    <Tooltip.Portal>
      <Tooltip.Content class="section-info-tooltip">{props.label}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip>
}
