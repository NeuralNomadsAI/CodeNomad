import { Select } from "@kobalte/core/select"
import { createMemo, createSignal, lazy, onMount, Show, Suspense, type Component } from "solid-js"
import { ChevronDown, RefreshCw, Save } from "lucide-solid"
import type { ConfigFileDescriptor } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import { showConfirmDialog } from "../../stores/alerts"

const LazyMonacoFileViewer = lazy(() =>
  import("../file-viewer/monaco-file-viewer").then((module) => ({ default: module.MonacoFileViewer })),
)

export const ConfigFilesSettingsSection: Component = () => {
  const { t } = useI18n()
  const [files, setFiles] = createSignal<ConfigFileDescriptor[]>([])
  const [selectedFileId, setSelectedFileId] = createSignal<string | null>(null)
  const [content, setContent] = createSignal("")
  const [originalContent, setOriginalContent] = createSignal("")
  const [exists, setExists] = createSignal<boolean | null>(null)
  const [loadingList, setLoadingList] = createSignal(false)
  const [loadingContent, setLoadingContent] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let loadVersion = 0

  const selectedFile = createMemo(() => files().find((file) => file.id === selectedFileId()) ?? null)
  const dirty = createMemo(() => content() !== originalContent())

  const loadContent = async (file: ConfigFileDescriptor) => {
    const version = ++loadVersion
    setLoadingContent(true)
    setError(null)
    try {
      const response = await serverApi.readConfigFile(file.id)
      if (version !== loadVersion) return
      setSelectedFileId(file.id)
      setContent(response.contents)
      setOriginalContent(response.contents)
      setExists(response.exists)
    } catch (loadError) {
      if (version !== loadVersion) return
      setError(loadError instanceof Error ? loadError.message : t("settings.configFiles.errors.loadContent"))
      setContent("")
      setOriginalContent("")
      setExists(null)
    } finally {
      if (version === loadVersion) setLoadingContent(false)
    }
  }

  const confirmDiscardIfDirty = async () => {
    if (!dirty()) return true
    return showConfirmDialog(t("settings.configFiles.confirmDiscard.message"), {
      variant: "warning",
      confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"),
      cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"),
      dismissible: false,
    })
  }

  const loadFiles = async () => {
    setLoadingList(true)
    setError(null)
    try {
      const response = await serverApi.listConfigFiles()
      setFiles(response)
      const first = response[0]
      if (first) {
        await loadContent(first)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("settings.configFiles.errors.loadList"))
    } finally {
      setLoadingList(false)
    }
  }

  const handleFileChange = async (file: ConfigFileDescriptor | null) => {
    if (!file || file.id === selectedFileId()) return
    const confirmed = await confirmDiscardIfDirty()
    if (!confirmed) return
    await loadContent(file)
  }

  const handleReload = async () => {
    const file = selectedFile()
    if (!file) return
    const confirmed = await confirmDiscardIfDirty()
    if (!confirmed) return
    await loadContent(file)
  }

  const handleSave = async () => {
    const file = selectedFile()
    if (!file) return
    setSaving(true)
    setError(null)
    try {
      await serverApi.writeConfigFile(file.id, content())
      setOriginalContent(content())
      setExists(true)
      showToastNotification({ message: t("settings.configFiles.toast.saveSuccess"), variant: "success" })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.configFiles.errors.save"))
      showToastNotification({ message: t("settings.configFiles.toast.saveError"), variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  onMount(() => {
    void loadFiles()
  })

  return (
    <div class="settings-section-stack config-files-section">
      <div class="config-files-card">
        <div class="config-files-toolbar">
          <div class="config-files-selector-field">
            <Select<ConfigFileDescriptor>
              value={selectedFile() ?? undefined}
              onChange={(file) => void handleFileChange(file)}
              options={files()}
              optionValue="id"
              optionTextValue="label"
              disabled={loadingList() || files().length === 0}
              itemComponent={(itemProps) => (
                <Select.Item item={itemProps.item} class="selector-option">
                  <div class="selector-option-content">
                    <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                    <div class="selector-option-description config-files-selector-path">{itemProps.item.rawValue.path}</div>
                  </div>
                </Select.Item>
              )}
            >
              <Select.Trigger class="selector-trigger config-files-selector-trigger" aria-label={t("settings.configFiles.selector.label")}>
                <div class="config-files-selector-value">
                  <Select.Value<ConfigFileDescriptor>>
                    {(state) => (
                      <span class="config-files-selector-value-inner">
                        <span class="selector-trigger-primary selector-trigger-primary--align-left">
                          {state.selectedOption()?.label ?? t("settings.configFiles.selector.placeholder")}
                        </span>
                        <Show when={state.selectedOption()}>
                          {(file) => <span class="selector-trigger-secondary config-files-selector-path">{file().path}</span>}
                        </Show>
                      </span>
                    )}
                  </Select.Value>
                </div>
                <Select.Icon class="selector-trigger-icon">
                  <ChevronDown class="w-3 h-3" />
                </Select.Icon>
              </Select.Trigger>

              <Select.Portal>
                <Select.Content class="selector-popover">
                  <Select.Listbox class="selector-listbox" />
                </Select.Content>
              </Select.Portal>
            </Select>
          </div>

          <div class="config-files-actions">
            <button
              type="button"
              class="files-header-icon-button"
              title={t("settings.configFiles.actions.save")}
              aria-label={t("settings.configFiles.actions.save")}
              disabled={!selectedFile() || saving() || loadingContent() || !dirty()}
              onClick={() => void handleSave()}
            >
              <Show when={saving()} fallback={<Save class="h-4 w-4" />}>
                <RefreshCw class="h-4 w-4 animate-spin" />
              </Show>
            </button>
            <button
              type="button"
              class="files-header-icon-button"
              title={t("settings.configFiles.actions.reload")}
              aria-label={t("settings.configFiles.actions.reload")}
              disabled={!selectedFile() || loadingContent() || saving()}
              onClick={() => void handleReload()}
            >
              <RefreshCw class={`h-4 w-4${loadingContent() ? " animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <Show when={selectedFile() && (dirty() || exists() === false)}>
          <div class="config-files-state-row">
            <Show when={dirty()} fallback={<span class="config-files-state">{t("settings.configFiles.state.notCreated")}</span>}>
              <span class="config-files-state">{t("settings.configFiles.state.unsaved")}</span>
            </Show>
          </div>
        </Show>

        <Show when={error()}>{(message) => <div class="settings-error-message">{message()}</div>}</Show>

        <div class="config-files-editor-shell file-viewer-panel">
          <Show
            when={!loadingList() && !loadingContent() && selectedFile()}
            fallback={<div class="config-files-editor-empty">{loadingList() || loadingContent() ? t("instanceInfo.loading") : t("settings.configFiles.empty")}</div>}
          >
            {(file) => (
              <div class="file-viewer-content file-viewer-content--monaco config-files-editor-content">
                <Suspense fallback={<div class="config-files-editor-empty">{t("instanceInfo.loading")}</div>}>
                  <LazyMonacoFileViewer
                    scopeKey="settings-config-files"
                    path={file().path}
                    content={content()}
                    wordWrap="off"
                    onSave={() => void handleSave()}
                    onContentChange={(nextContent) => setContent(nextContent)}
                  />
                </Suspense>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
