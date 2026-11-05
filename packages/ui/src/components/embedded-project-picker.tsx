import { For, Show, type Component } from "solid-js"
import { Folder, FolderPlus } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import { useConfig } from "../stores/preferences"
import { createNewInstanceDialogs } from "./new-instance-dialogs"

interface EmbeddedProjectPickerProps {
  isLoading: boolean
  onSelectFolder: (path: string) => void
}

/** The embedded single-project page before it shows a project: this server's recent folders and its folder browser. */
export const EmbeddedProjectPicker: Component<EmbeddedProjectPickerProps> = (props) => {
  const { t } = useI18n()
  const { recentFolders } = useConfig()
  const select = (path: string) => { if (!props.isLoading) props.onSelectFolder(path) }
  const dialogs = createNewInstanceDialogs({
    defaultPath: () => recentFolders()[0]?.path,
    isLoading: () => props.isLoading,
    onSelectFolder: select,
  })

  return (
    <div class="flex-1 min-h-0 overflow-auto flex bg-surface-canvas" data-embedded-project-picker>
      <div class="embedded-project-picker" aria-busy={props.isLoading}>
        <button type="button" class="button-primary w-full flex items-center justify-center gap-2 text-sm"
          disabled={props.isLoading} onClick={() => void dialogs.browse()}>
          <FolderPlus class="w-4 h-4" aria-hidden="true" />
          <span>{t("folderSelection.browse.button")}</span>
        </button>
        <Show when={recentFolders().length > 0}>
          <div class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{t("folderSelection.recent.title")}</h2>
            </div>
            <div class="panel-list">
              <For each={recentFolders()}>
                {(folder) => (
                  <button type="button" class="panel-list-item panel-list-item-content w-full text-start"
                    disabled={props.isLoading} title={folder.path} onClick={() => select(folder.path)}>
                    <span class="flex items-center gap-2 min-w-0">
                      <Folder class="w-4 h-4 flex-shrink-0 icon-muted" aria-hidden="true" />
                      <span class="text-sm font-medium truncate text-primary">{getProjectDisplayName(folder.path, folder.projectName)}</span>
                    </span>
                    <span class="block pl-6 text-xs text-muted font-mono truncate-start">{getDisplayPath(folder.path)}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
      <dialogs.Dialogs />
    </div>
  )
}
