import { For, Show, type JSX } from "solid-js"
import { Pause, Play, RefreshCw } from "lucide-solid"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"

function primaryIcon(key: string): JSX.Element {
  if (key === "pause") return <Pause class="h-3.5 w-3.5" aria-hidden="true" />
  if (key === "check" || key === "status") return <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
  return <Play class="h-3.5 w-3.5" aria-hidden="true" />
}

/** Compact actions of the selected Mission/schedule, at the top of its detail:
 * the contextual lifecycle action first, then the remaining available actions. */
export function MissionActionBar(props: { label: string; primary?: MissionPrimaryAction; items: ActionOverflowMenuItem[]; feedback?: JSX.Element }) {
  return <>
    <div class="mission-action-bar" role="group" aria-label={props.label}>
      <Show when={props.primary}>{action => <button type="button" class="window-text-button mission-index-primary"
        aria-label={action().ariaLabel ?? action().label} title={action().ariaLabel ?? action().label} disabled={action().disabled}
        onClick={() => void action().onSelect()}>{primaryIcon(action().key)}<span>{action().label}</span></button>}</Show>
      <For each={props.items}>{item => <button type="button" class="window-text-button" disabled={item.disabled}
        title={item.description ?? item.label} aria-description={item.description} onClick={() => void item.onSelect()}>
        <Show when={item.icon}><span class="mission-action-icon" aria-hidden="true">{item.icon}</span></Show><span>{item.label}</span>
      </button>}</For>
    </div>
    <div class="mission-action-feedback">{props.feedback}</div>
  </>
}
