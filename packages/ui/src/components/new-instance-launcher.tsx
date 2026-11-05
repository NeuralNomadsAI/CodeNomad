import { Popover } from "@kobalte/core/popover"
import { useI18n } from "../lib/i18n"
import { launchableRecents } from "../stores/remote-project-open"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import BrowseMenu from "./browse-menu"
import RecentTabsMenu from "./recent-tabs-menu"
import NewTabActions from "./new-tab-actions"

interface NewInstanceLauncherProps {
  open: boolean
  anchor?: HTMLElement
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onNewTemporaryInstance: () => void
}

/** The compact + launcher: search, Recent, Browse, Clone and New temporary tab. */
export default function NewInstanceLauncher(props: NewInstanceLauncherProps) {
  const { t } = useI18n()
  const dialogs = createNewInstanceDialogs({
    defaultPath: () => launchableRecents().find((entry) => !entry.remote && !entry.sidecar)?.path,
    isLoading: () => props.isLoading,
    onSelectFolder: props.onSelectFolder,
  })
  const close = () => props.onOpenChange(false)
  let returnFocus = false
  let content: HTMLDivElement | undefined
  return (
    <>
      <Popover open={props.open} onOpenChange={props.onOpenChange} anchorRef={() => props.anchor} placement="bottom-start" gutter={6}>
        <Popover.Portal>
          <Popover.Content class="window-shell new-instance-launcher" aria-busy={props.isLoading} ref={content}
            onEscapeKeyDown={() => { returnFocus = true }} onCloseAutoFocus={(event) => {
              event.preventDefault()
              const active = document.activeElement
              if (returnFocus && (!active || active === document.body || content?.contains(active))) props.anchor?.focus()
              returnFocus = false
            }}>
            <header class="window-header"><Popover.Title class="window-title">{t("newInstanceLauncher.title")}</Popover.Title></header>
            <Popover.Description class="sr-only">{t("newInstanceLauncher.description")}</Popover.Description>
            <RecentTabsMenu active={props.open} isLoading={props.isLoading} onRun={close}
              onSelectFolder={props.onSelectFolder} onSelectExistingInstance={props.onSelectExistingInstance} />
            <BrowseMenu isLoading={props.isLoading} onRun={close} onBrowseLocal={() => void dialogs.browse()} />
            <div class="new-instance-launcher-actions"><NewTabActions variant="launcher" isLoading={props.isLoading}
              onRun={close} onClone={dialogs.clone} onNewTemporary={props.onNewTemporaryInstance} /></div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
      <dialogs.Dialogs />
    </>
  )
}
