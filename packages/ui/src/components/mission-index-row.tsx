import { Show, createUniqueId, type JSX } from "solid-js"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"
import { useI18n } from "../lib/i18n"

/** One Mission/schedule entry: a selectable title and state line, at most one
 * visible text action, every other available action in the overflow menu. The
 * selected entry's card follows the row inside the same list item. */
export function MissionIndexRow(props: {
  title: string; badge?: JSX.Element; meta: JSX.Element; statusKind?: string
  selected: boolean; onSelect: () => void; cardId: string
  primary?: MissionPrimaryAction; menu: ActionOverflowMenuItem[]
  feedback?: JSX.Element; children?: JSX.Element
}) {
  const { t } = useI18n()
  const metaId = createUniqueId()
  return <li class="mission-index-entry" classList={{ "mission-index-entry-selected": props.selected }}>
    <div class="mission-index-row" data-status={props.statusKind}>
      <button type="button" class="mission-index-select" aria-label={props.title} aria-describedby={metaId}
        aria-current={props.selected ? "true" : undefined} aria-expanded={props.selected}
        aria-controls={props.selected ? props.cardId : undefined} onClick={() => props.onSelect()}>
        <span class="mission-index-title"><bdi title={props.title}>{props.title}</bdi>{props.badge}</span>
        <span id={metaId} class="mission-index-meta">{props.meta}</span>
      </button>
      <div class="mission-index-actions">
        <Show when={props.primary}>{action => <button type="button" class="window-text-button mission-index-primary"
          aria-label={action().ariaLabel} title={action().ariaLabel} disabled={action().disabled}
          onClick={() => void action().onSelect()}>{action().label}</button>}</Show>
        <ActionOverflowMenu items={props.menu} label={t("missionsPanel.moreActions")} triggerClass="mission-index-more" />
      </div>
    </div>
    <div class="mission-index-feedback">{props.feedback}</div>
    <Show when={props.selected}><div id={props.cardId} class="mission-card">{props.children}</div></Show>
  </li>
}
