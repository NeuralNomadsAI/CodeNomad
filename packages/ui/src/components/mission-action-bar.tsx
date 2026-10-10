import { Show, type JSX } from "solid-js"
import { ArrowUpRight, Eye, MessageSquareText, Minus, Pause, Pencil, Play, RefreshCw, Square } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"

function primaryIcon(key?: string): JSX.Element {
  if (key === "pause") return <Pause class="h-3.5 w-3.5" aria-hidden="true" />
  if (key === "check" || key === "status") return <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
  return <Play class="h-3.5 w-3.5" aria-hidden="true" />
}

/** One row of icon buttons above the selected Mission/schedule's task tree:
 * contextual Play/Pause (or recovery) and Stop, a separator, then summary
 * reader, update request, coordinator conversation, edit and delete.
 * Inapplicable buttons stay in place, disabled. Only a schedule's secondary
 * controls (such as Run now) use a trailing menu, and only when present. */
export function MissionActionBar(props: {
  label: string; reading: boolean; onToggleReader: () => void
  primary?: MissionPrimaryAction; stop?: MissionPrimaryAction; request?: MissionPrimaryAction; onOpenConversation?: () => void
  onEdit?: () => void; onDelete?: () => void; editDisabled?: boolean; deleteDisabled?: boolean
  items?: ActionOverflowMenuItem[]; feedback?: JSX.Element
}) {
  const { t } = useI18n()
  const primaryLabel = () => props.primary ? props.primary.ariaLabel ?? props.primary.label : t("missionsPanel.action.start")
  const stopLabel = () => props.stop ? props.stop.ariaLabel ?? props.stop.label : t("missions.control.run.stop")
  const requestTitle = () => props.request?.ariaLabel ?? t("missionsPanel.action.requestUpdate")
  return <>
    <div class="mission-action-bar" role="toolbar" aria-label={props.label}>
      <button type="button" class="mission-control-icon-button" aria-label={primaryLabel()} title={primaryLabel()}
        disabled={!props.primary || props.primary.disabled} onClick={() => void props.primary?.onSelect()}>
        {primaryIcon(props.primary?.key)}
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={stopLabel()} title={stopLabel()}
        disabled={!props.stop || props.stop.disabled} onClick={() => void props.stop?.onSelect()}>
        <Square class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span class="mission-action-separator" role="separator" aria-orientation="vertical" />
      <button type="button" class="mission-control-icon-button icon-toggle mission-overview-toggle" aria-pressed={props.reading}
        aria-label={t("missionsPanel.overview")} title={t("missionsPanel.overview")} onClick={() => props.onToggleReader()}>
        <Eye class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.action.requestUpdate")}
        title={requestTitle()} aria-description={props.request?.ariaLabel}
        disabled={!props.request || props.request.disabled} onClick={() => void props.request?.onSelect()}>
        <MessageSquareText class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.action.openConversation")}
        title={t("missionsPanel.action.openConversation")} disabled={!props.onOpenConversation} onClick={() => props.onOpenConversation?.()}>
        <ArrowUpRight class="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.picker.edit")} title={t("missionsPanel.picker.edit")}
        disabled={!props.onEdit || props.editDisabled} onClick={() => props.onEdit?.()}><Pencil class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.picker.delete")} title={t("missionsPanel.picker.delete")}
        disabled={!props.onDelete || props.deleteDisabled} onClick={() => props.onDelete?.()}><Minus class="h-4 w-4" aria-hidden="true" /></button>
      <Show when={props.items?.length}>
        <ActionOverflowMenu items={props.items!} minItems={0} label={t("missionsPanel.moreActions")} triggerClass="mission-control-icon-button" />
      </Show>
    </div>
    <div class="mission-action-feedback">{props.feedback}</div>
  </>
}
