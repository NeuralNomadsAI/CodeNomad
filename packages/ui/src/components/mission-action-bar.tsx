import { Show, type JSX } from "solid-js"
import { ArrowUpRight, Eye, FastForward, Pause, Pencil, Play, RefreshCw, Square, Trash2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"

function primaryIcon(key?: string): JSX.Element {
  if (key === "pause") return <Pause class="h-3.5 w-3.5" aria-hidden="true" />
  if (key === "check" || key === "status") return <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
  return <Play class="h-3.5 w-3.5" aria-hidden="true" />
}

/** One row of icon buttons above the selected Mission/schedule's task tree:
 * contextual Play/Pause (or recovery), Stop and, for schedules only, Run now;
 * a separator, then summary reader, coordinator conversation, edit and delete.
 * Inapplicable buttons stay in place, disabled. An available update request and
 * optional secondary text actions share one compact row below the toolbar. */
export function MissionActionBar(props: {
  label: string; reading: boolean; onToggleReader: () => void
  primary?: MissionPrimaryAction; stop?: MissionPrimaryAction; request?: MissionPrimaryAction; onOpenConversation?: () => void
  onEdit?: () => void; onDelete?: () => void; editDisabled?: boolean; deleteDisabled?: boolean
  runNow?: MissionPrimaryAction; secondary?: JSX.Element; feedback?: JSX.Element
}) {
  const { t } = useI18n()
  const primaryLabel = () => props.primary ? props.primary.ariaLabel ?? props.primary.label : t("missionsPanel.action.start")
  const stopLabel = () => props.stop ? props.stop.ariaLabel ?? props.stop.label : t("missions.control.run.stop")
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
      <Show when={props.runNow}>{runNow =>
        <button type="button" class="mission-control-icon-button" aria-label={runNow().ariaLabel ?? runNow().label} title={runNow().ariaLabel ?? runNow().label}
          disabled={runNow().disabled} onClick={() => void runNow().onSelect()}>
          <FastForward class="h-3.5 w-3.5" aria-hidden="true" />
        </button>}
      </Show>
      <span class="mission-action-separator" role="separator" aria-orientation="vertical" />
      <button type="button" class="mission-control-icon-button icon-toggle mission-overview-toggle" aria-pressed={props.reading}
        aria-label={t("missionsPanel.overview")} title={t("missionsPanel.overview")} onClick={() => props.onToggleReader()}>
        <Eye class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.action.openConversation")}
        title={t("missionsPanel.action.openConversation")} disabled={!props.onOpenConversation} onClick={() => props.onOpenConversation?.()}>
        <ArrowUpRight class="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.picker.edit")} title={t("missionsPanel.picker.edit")}
        disabled={!props.onEdit || props.editDisabled} onClick={() => props.onEdit?.()}><Pencil class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.picker.delete")} title={t("missionsPanel.picker.delete")}
        disabled={!props.onDelete || props.deleteDisabled} onClick={() => props.onDelete?.()}><Trash2 class="h-4 w-4" aria-hidden="true" /></button>
    </div>
    <Show when={props.request || props.secondary}>
      <div class="mission-action-texts">
        <Show when={props.request}>{request =>
          <button type="button" class="window-text-button mission-action-request" title={request().ariaLabel}
            disabled={request().disabled} onClick={() => void request().onSelect()}>{request().label}</button>}
        </Show>
        {props.secondary}
      </div>
    </Show>
    <div class="mission-action-feedback">{props.feedback}</div>
  </>
}
