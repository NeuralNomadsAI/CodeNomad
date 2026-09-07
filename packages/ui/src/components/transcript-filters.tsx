import { Popover } from "@kobalte/core/popover"
import { Dynamic } from "solid-js/web"
import { For, Show, createMemo, createSignal } from "solid-js"
import { Brain, BookOpen, CheckSquare, ChevronDown, ChevronRight, Eye, EyeOff, FileEdit, Globe, ListFilter, Pencil, Search, Terminal, Wrench, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { useConfig, type VisibilityPreference } from "../stores/preferences"
import { transcriptVisibility, transcriptVisibilityPatch, transcriptVisibilityRows } from "./transcript-visibility"

const contentIcons: Record<string, typeof Wrench> = {
  thinking: Brain, bash: Terminal, read: BookOpen, write: FileEdit, edit: Pencil,
  patch: Wrench, apply_patch: Wrench, webfetch: Globe, glob: Search, grep: Search, todowrite: CheckSquare,
}

export default function TranscriptFilters() {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const rows = createMemo(() => transcriptVisibilityRows(t))
  const [saving, setSaving] = createSignal(false)
  return (
    <Popover placement="bottom-end" gutter={6}>
      <Popover.Trigger class="window-icon-button transcript-filters-trigger" aria-label={t("transcriptFilters.title")} title={t("transcriptFilters.title")}>
        <ListFilter class="w-4 h-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="window-shell transcript-filters" aria-busy={saving()}>
          <header class="window-header">
            <Popover.Title class="window-title">{t("transcriptFilters.title")}</Popover.Title>
            <Popover.CloseButton class="window-icon-button" aria-label={t("toastHistory.close")}><X class="w-4 h-4" aria-hidden="true" /></Popover.CloseButton>
          </header>
          <Popover.Description class="transcript-filters-description">{t("transcriptFilters.description")}</Popover.Description>
          <div class="window-body transcript-filters-list">
            <For each={rows()}>{(row) => {
              const mode = () => transcriptVisibility(preferences(), row)
              let previousVisible: VisibilityPreference = "collapsed"
              const setMode = async (value: VisibilityPreference) => {
                if (saving()) return
                setSaving(true)
                try {
                  const saved = await updatePreferences(transcriptVisibilityPatch(preferences(), row, value))
                  if (!saved) showToastNotification({ message: t("settings.speech.save.error"), variant: "error" })
                } finally {
                  setSaving(false)
                }
              }
              const visibilityLabel = () => t(mode() === "hidden" ? "transcriptFilters.show" : "transcriptFilters.hide", { name: row.label })
              const expansionLabel = () => t(mode() === "expanded" ? "transcriptFilters.collapse" : "transcriptFilters.expand", { name: row.label })
              return (
                <div class="transcript-filter-row" role="group" aria-label={row.label}>
                  <Dynamic component={contentIcons[row.key] ?? Wrench} class="w-4 h-4" aria-hidden="true" />
                  <span class="transcript-filter-label" title={row.label}>{row.label}</span>
                  <button type="button" class="window-icon-button" aria-label={visibilityLabel()} title={visibilityLabel()} aria-pressed={mode() !== "hidden"} aria-disabled={saving()}
                    onClick={() => {
                      if (saving()) return
                      if (mode() === "hidden") setMode(previousVisible)
                      else { previousVisible = mode(); setMode("hidden") }
                    }}>
                    <Show when={mode() !== "hidden"} fallback={<EyeOff class="w-4 h-4" aria-hidden="true" />}><Eye class="w-4 h-4" aria-hidden="true" /></Show>
                  </button>
                  <button type="button" class="window-icon-button" disabled={mode() === "hidden"} aria-disabled={saving() || mode() === "hidden"} aria-label={expansionLabel()} title={expansionLabel()} aria-pressed={mode() === "expanded"}
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
