import { useI18n } from "../lib/i18n"
import { launchableRecents } from "../stores/remote-project-open"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import BrowseMenu, { browseEntryCount } from "./browse-menu"
import RecentTabsMenu from "./recent-tabs-menu"
import NewTabActions from "./new-tab-actions"
import EntryCount from "./entry-count"

/** A new browser-like tab: choices use the ordinary open flows and replace this empty tab on success. */
export default function BlankTabView(props: {
  active: boolean
  isLoading: boolean
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onNewTemporaryInstance: () => void
}) {
  const { t } = useI18n()
  const dialogs = createNewInstanceDialogs({
    defaultPath: () => launchableRecents().find((entry) => !entry.remote && !entry.sidecar)?.path,
    isLoading: () => props.isLoading,
    onSelectFolder: props.onSelectFolder,
  })
  return (
    <div class="blank-tab-view">
      <div class="blank-tab-columns">
        <section class="panel blank-tab-section">
          <RecentTabsMenu alwaysOpen counts active={props.active} isLoading={props.isLoading}
            onSelectFolder={props.onSelectFolder} onSelectExistingInstance={props.onSelectExistingInstance} />
        </section>
        <section class="panel blank-tab-section">
          <div class="panel-header"><div><h2 class="panel-title">{t("folderSelection.browseMenu.title")}</h2>
            <EntryCount count={browseEntryCount()} /></div></div>
          <BrowseMenu alwaysOpen isLoading={props.isLoading} onBrowseLocal={() => void dialogs.browse()} />
        </section>
      </div>
      <div class="blank-tab-actions"><NewTabActions variant="launcher" isLoading={props.isLoading}
        onClone={dialogs.clone} onNewTemporary={props.onNewTemporaryInstance} /></div>
      <dialogs.Dialogs />
    </div>
  )
}
