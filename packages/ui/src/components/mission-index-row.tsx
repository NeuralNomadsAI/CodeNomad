import { Show, createUniqueId, type JSX } from "solid-js"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"
import { useI18n } from "../lib/i18n"

/** One Mission/schedule entry in exactly two lines (title, then state), at most
 * one visible text action and every other available action in the overflow
 * menu. The selected entry's detail is a separate section below the list. */
export function MissionIndexRow(props: {
  title: string; meta: JSX.Element; statusKind?: string
  selected: boolean; onSelect: () => void; detailId: string
  primary?: MissionPrimaryAction; menu: ActionOverflowMenuItem[]
  feedback?: JSX.Element
}) {
  const { t } = useI18n()
  const metaId = createUniqueId()
  return <li class="mission-index-entry" classList={{ "mission-index-entry-selected": props.selected }}>
    <div class="mission-index-row" data-status={props.statusKind}>
      <button type="button" class="mission-index-select" aria-label={props.title} aria-describedby={metaId}
        aria-current={props.selected ? "true" : undefined} aria-controls={props.selected ? props.detailId : undefined}
        onClick={() => props.onSelect()}>
        <span class="mission-index-title"><bdi title={props.title}>{props.title}</bdi></span>
        <span id={metaId} class="mission-index-meta">{props.meta}</span>
      </button>
      <div class="mission-index-actions">
        <Show when={props.primary}>{action => <button type="button" class="window-text-button mission-index-primary"
          aria-label={action().ariaLabel} title={action().ariaLabel} disabled={action().disabled}
          onClick={() => void action().onSelect()}>{action().label}</button>}</Show>
        <Show when={props.menu.length}><ActionOverflowMenu items={props.menu} label={t("missionsPanel.moreActions")} triggerClass="mission-index-more" /></Show>
      </div>
    </div>
    <div class="mission-index-feedback">{props.feedback}</div>
  </li>
}
