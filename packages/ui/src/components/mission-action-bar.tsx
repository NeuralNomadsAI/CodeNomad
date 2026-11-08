import { Show, createContext, createMemo, useContext, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { ArrowUpRight, BookmarkPlus, PauseCircle, Eye, FastForward, Pause, Pencil, Play, RefreshCw, Square, Trash2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"
import type { MissionBriefSaveTrigger } from "./mission-model-library"

/** The Missions header's selection line: a selected item's toolbar mounts there. */
export const MissionActionSlot = createContext<Accessor<HTMLElement | undefined>>()
/** True while an open task reader's toolbar owns the selection line (a schedule's passage task). */
export const MissionTaskToolbarActive = createContext<Accessor<boolean>>()

function primaryIcon(key?: string): JSX.Element {
  if (key === "pause") return <Pause class="h-3.5 w-3.5" aria-hidden="true" />
  if (key === "check" || key === "status") return <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
  return <Play class="h-3.5 w-3.5" aria-hidden="true" />
}

/** The selected Mission/schedule's icon toolbar, mounted in the header's selection
 * line: contextual Play/Pause (or recovery), Stop and, for schedules only, Run now,
 * then the summary reader, coordinator conversation and delete, then the shared
 * overflow menu (update request, interrupt now, save as brief, edit). Inapplicable buttons stay in
 * place, disabled. Optional secondary text actions and feedback stay in the detail. */
export function MissionActionBar(props: {
  label: string; reading: boolean; onToggleReader?: () => void
  primary?: MissionPrimaryAction; stop?: MissionPrimaryAction; request?: MissionPrimaryAction; onOpenConversation?: () => void
  /** Names Open conversation's target when it is not the coordinator's. */
  openLabel?: string
  /** Interrupts a graceful Pause's still-running steps at once. */
  interrupt?: MissionPrimaryAction
  onEdit?: () => void; onDelete?: () => void; editDisabled?: boolean; deleteDisabled?: boolean
  runNow?: MissionPrimaryAction; secondary?: JSX.Element; feedback?: JSX.Element
  /** Opens the selected Mission's inline brief name field (in `secondary`). */
  saveBrief?: MissionBriefSaveTrigger
  /** Renders in place instead of in the header's selection line. */
  inline?: boolean
  /** An open task reader's toolbar, which takes the line from its schedule's. */
  task?: boolean
}) {
  const { t } = useI18n()
  const slot = useContext(MissionActionSlot)
  const taskOwned = useContext(MissionTaskToolbarActive)
  // A refreshed action object must keep the SVG beneath an already-held pointer.
  const primaryKey = createMemo(() => props.primary?.key)
  const primaryLabel = () => props.primary ? props.primary.ariaLabel ?? props.primary.label : t("missionsPanel.action.start")
  const stopLabel = () => props.stop ? props.stop.ariaLabel ?? props.stop.label : t("missions.control.run.stop")
  const menu: ActionOverflowMenuItem[] = [
    { key: "request", get label() { return props.request?.label ?? t("missionsPanel.action.requestUpdate") },
      get description() { return props.request?.ariaLabel }, get icon() { return <RefreshCw class="h-3.5 w-3.5" /> },
      get disabled() { return !props.request || props.request.disabled }, onSelect: () => props.request?.onSelect() },
    { key: "interrupt", get label() { return props.interrupt?.label ?? t("missionsPanel.action.interruptNow") },
      get description() { return props.interrupt?.ariaLabel }, get icon() { return <PauseCircle class="h-3.5 w-3.5" /> },
      get disabled() { return !props.interrupt || props.interrupt.disabled }, onSelect: () => props.interrupt?.onSelect() },
    { key: "save-brief", get label() { return t("missions.create.brief.saveAs") }, get icon() { return <BookmarkPlus class="h-3.5 w-3.5" /> },
      get disabled() { return !props.saveBrief || props.saveBrief.disabled() },
      // The field it opens gives focus back to this menu's trigger when it closes.
      onSelect: () => props.saveBrief?.open(bar?.querySelector<HTMLElement>(".action-overflow-trigger") ?? undefined) },
    { key: "edit", get label() { return t("missionsPanel.picker.edit") }, get icon() { return <Pencil class="h-3.5 w-3.5" /> },
      get disabled() { return !props.onEdit || props.editDisabled }, onSelect: () => props.onEdit?.() },
  ]
  let bar: HTMLDivElement | undefined
  const toolbar = () => <div ref={bar} class="mission-action-bar" role="toolbar" aria-label={props.label}>
    <button type="button" class="mission-control-icon-button" aria-label={primaryLabel()} title={primaryLabel()}
      disabled={!props.primary || props.primary.disabled} onClick={() => void props.primary?.onSelect()}>
      {primaryIcon(primaryKey())}
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
    <button type="button" class="mission-control-icon-button icon-toggle mission-overview-toggle" aria-pressed={props.reading}
      aria-label={t("missionsPanel.overview")} title={t("missionsPanel.overview")} disabled={!props.onToggleReader} onClick={() => props.onToggleReader?.()}>
      <Eye class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    <button type="button" class="mission-control-icon-button" aria-label={props.openLabel ?? t("missionsPanel.action.openConversation")}
      title={props.openLabel ?? t("missionsPanel.action.openConversation")} disabled={!props.onOpenConversation} onClick={() => props.onOpenConversation?.()}>
      <ArrowUpRight class="h-4 w-4" aria-hidden="true" />
    </button>
    <button type="button" class="mission-control-icon-button" aria-label={t("missionsPanel.picker.delete")} title={t("missionsPanel.picker.delete")}
      disabled={!props.onDelete || props.deleteDisabled} onClick={() => props.onDelete?.()}><Trash2 class="h-4 w-4" aria-hidden="true" /></button>
    <ActionOverflowMenu label={t("messageItem.actions.more")} items={menu} triggerClass="mission-control-icon-button" />
  </div>
  const mount = () => props.inline ? undefined : slot?.()
  // A schedule's toolbar yields the line while one of its passage tasks' reader is open.
  const yielded = () => !props.inline && !props.task && Boolean(taskOwned?.())
  return <>
    <Show when={!yielded()}>
      <Show when={mount()} keyed fallback={toolbar()}>{element => <Portal mount={element}>{toolbar()}</Portal>}</Show>
    </Show>
    <Show when={props.secondary}><div class="mission-action-texts">{props.secondary}</div></Show>
    <div class="mission-action-feedback">{props.feedback}</div>
  </>
}
