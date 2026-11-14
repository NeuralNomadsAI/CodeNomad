import { Popover } from "@kobalte/core/popover"
import IconButton from "@suid/material/IconButton"
import { Dynamic } from "solid-js/web"
import { For, Show, createMemo, createSignal } from "solid-js"
import { ChevronDown, ChevronRight, Eye, EyeOff, ListFilter } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { nativeSelectListOpen } from "../lib/native-select-open"
import { showToastNotification } from "../lib/notifications"
import { afterSweep, toggleSweepGroup } from "../lib/toggle-sweep"
import { useConfig, type Preferences, type ToolCallExpansionPreset, type VisibilityPreference } from "../stores/preferences"
import { getMessageContentIcon } from "./message-content-icons"
import {
  TRANSCRIPT_PRESETS,
  transcriptPreset,
  transcriptPresetPatch,
  transcriptVisibility,
  transcriptVisibilityPatch,
  transcriptVisibilityRows,
  type TranscriptVisibilityRow,
} from "./transcript-visibility"

interface TranscriptFiltersProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  overflowAnchor?: () => HTMLElement | undefined
}

export default function TranscriptFilters(props: TranscriptFiltersProps = {}) {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const rows = createMemo(() => transcriptVisibilityRows(t))
  const [pending, setPending] = createSignal(0)
  const saving = () => pending() > 0
  // Row changes show at once and stay here until the save carrying them settles.
  type RowRequest = { mode: VisibilityPreference }
  const [requested, setRequested] = createSignal<ReadonlyMap<string, RowRequest>>(new Map())
  const preset = createMemo(() => transcriptPreset(preferences()))
  const presetLabel = (value: string) => t(`settings.behavior.expansionPreset.${value}.title`)
  // Changes save in order, each built from the preferences the previous one saved, so
  // quick successive toggles (a drag sweep across rows) all apply.
  let queue = Promise.resolve()
  const save = (patch: () => Partial<Preferences>, settled?: () => void) => {
    setPending((count) => count + 1)
    queue = queue.then(async () => {
      try {
        const saved = await updatePreferences(patch())
        if (!saved) showToastNotification({ category: "settings", message: t("settings.speech.save.error"), variant: "error" })
      } finally {
        setPending((count) => count - 1)
        settled?.()
      }
    })
    return queue
  }
  // Each saved change re-renders the transcript, so a sweep saves its rows once, on release.
  // A batch is sealed as it joins the queue: it never carries a later click past a preset
  // change, nor a sweep that has not ended.
  let batch = new Map<string, RowRequest>()
  const requestMode = (row: TranscriptVisibilityRow, mode: VisibilityPreference) => {
    const request = { mode }
    batch.set(row.key, request)
    setRequested((current) => new Map(current).set(row.key, request))
    afterSweep(saveBatch)
  }
  const saveBatch = () => {
    if (batch.size === 0) return
    const sealed = batch
    batch = new Map()
    void save(() => {
      let merged = preferences(), patch: Partial<Preferences> = {}
      for (const target of rows()) {
        const request = sealed.get(target.key)
        if (!request) continue
        const next = transcriptVisibilityPatch(merged, target, request.mode)
        merged = { ...merged, ...next }
        patch = { ...patch, ...next }
      }
      return patch
    }, () => setRequested((current) => new Map([...current].filter(([key, request]) => sealed.get(key) !== request))))
  }
  return (
    <Popover placement="bottom-end" gutter={6} open={props.open} onOpenChange={props.onOpenChange}
      getAnchorRect={(anchor) => (props.overflowAnchor?.() ?? anchor)?.getBoundingClientRect()}>
      <Popover.Trigger as={IconButton} size="small" color="inherit" class="transcript-filters-trigger icon-toggle" aria-label={t("transcriptFilters.title")} title={t("transcriptFilters.title")}>
        <ListFilter class="w-4 h-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="window-shell transcript-filters" aria-busy={saving()} onCloseAutoFocus={(event) => {
          const anchor = props.overflowAnchor?.()
          if (anchor) { event.preventDefault(); anchor.focus() }
        }}>
          <header class="window-header">
            <Popover.Title class="window-title">{t("transcriptFilters.title")}</Popover.Title>
          </header>
          <Popover.Description class="sr-only">{t("transcriptFilters.description")}</Popover.Description>
          <div class="transcript-filters-preset">
            <select class="selector-trigger" value={preset()} aria-disabled={saving()}
              // Escape closes an open list first: keep it from the popup's document listener (not delegated).
              on:keydown={(event) => { if (event.key === "Escape" && nativeSelectListOpen(event.currentTarget)) event.stopPropagation() }}
              aria-label={t("settings.behavior.expansionPresets.ariaLabel")} title={t("settings.behavior.expansionPresets.ariaLabel")}
              onChange={(event) => {
                const select = event.currentTarget, value = select.value
                // The saved preference drives the shown value, including refused or failed changes.
                select.value = preset()
                if (value !== "custom") void save(() => transcriptPresetPatch(value as ToolCallExpansionPreset))
              }}>
              <For each={TRANSCRIPT_PRESETS}>{(value) => <option value={value}>{presetLabel(value)}</option>}</For>
              {/* Custom only names manual changes; it is not a choice. */}
              <option value="custom" disabled hidden={preset() !== "custom"}>{presetLabel("custom")}</option>
            </select>
          </div>
          <div class="window-body transcript-filters-list">
            <For each={rows()}>{(row) => {
              const mode = () => requested().get(row.key)?.mode ?? transcriptVisibility(preferences(), row)
              let previousVisible: VisibilityPreference = "collapsed"
              const setMode = (value: VisibilityPreference) => requestMode(row, value)
              const visibilityLabel = () => t(mode() === "hidden" ? "transcriptFilters.show" : "transcriptFilters.hide", { name: row.label })
              const expansionLabel = () => t(mode() === "expanded" ? "transcriptFilters.collapse" : "transcriptFilters.expand", { name: row.label })
              return (
                <div class="transcript-filter-row" role="group" aria-label={row.label}>
                  <Dynamic component={getMessageContentIcon(row.key)} class="w-4 h-4" aria-hidden="true" />
                  <span class="transcript-filter-label" title={row.label}>{row.label}</span>
                  <button type="button" class="window-icon-button" aria-label={visibilityLabel()} title={visibilityLabel()} aria-pressed={mode() !== "hidden"}
                    data-toggle-sweep={toggleSweepGroup("transcript-visibility")}
                    onClick={() => {
                      if (mode() === "hidden") setMode(previousVisible)
                      else { previousVisible = mode(); setMode("hidden") }
                    }}>
                    <Show when={mode() !== "hidden"} fallback={<EyeOff class="w-4 h-4" aria-hidden="true" />}><Eye class="w-4 h-4" aria-hidden="true" /></Show>
                  </button>
                  <button type="button" class="window-icon-button" disabled={mode() === "hidden"} aria-label={expansionLabel()} title={expansionLabel()} aria-pressed={mode() === "expanded"}
                    data-toggle-sweep={toggleSweepGroup("transcript-expansion")}
                    onClick={() => setMode(mode() === "expanded" ? "collapsed" : "expanded")}>
                    <Show when={mode() === "expanded"} fallback={<ChevronRight class="w-4 h-4" aria-hidden="true" />}><ChevronDown class="w-4 h-4" aria-hidden="true" /></Show>
                  </button>
                </div>
              )
            }}</For>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
