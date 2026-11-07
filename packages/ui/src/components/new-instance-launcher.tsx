import { Popover } from "@kobalte/core/popover"
import { useI18n } from "../lib/i18n"
import { FolderOpen } from "lucide-solid"
import RecentTabsMenu from "./recent-tabs-menu"

interface NewInstanceLauncherProps {
  open: boolean
  anchor?: HTMLElement
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onOpenAnotherProject: () => void
}

/** Quick recents only; other choices belong in a blank tab. */
export default function NewInstanceLauncher(props: NewInstanceLauncherProps) {
  const { t } = useI18n()
  const close = () => props.onOpenChange(false)
  let returnFocus = false
  let content: HTMLDivElement | undefined
  return (
    <>
      <Popover open={props.open} onOpenChange={props.onOpenChange} anchorRef={() => props.anchor} placement="bottom-start" gutter={6}>
        <Popover.Portal>
          <Popover.Content class="window-shell new-instance-launcher" aria-busy={props.isLoading} ref={content}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              content?.querySelector<HTMLInputElement>("input[type='search']")?.focus()
            }}
            onEscapeKeyDown={() => { returnFocus = true }} onCloseAutoFocus={(event) => {
              event.preventDefault()
              const active = document.activeElement
              if (returnFocus && !props.open && (!active || active === document.body || content?.contains(active))) props.anchor?.focus()
              returnFocus = false
            }}>
            <header class="window-header"><Popover.Title class="window-title">{t("newInstanceLauncher.title")}</Popover.Title></header>
            <Popover.Description class="sr-only">{t("newInstanceLauncher.description")}</Popover.Description>
            <RecentTabsMenu active={props.open} isLoading={props.isLoading} onRun={close}
              onSelectFolder={props.onSelectFolder} onSelectExistingInstance={props.onSelectExistingInstance} />
            <div class="window-footer new-instance-launcher-footer">
              <button type="button" class="window-text-button" disabled={props.isLoading}
                onClick={() => { close(); props.onOpenAnotherProject() }}>
                <FolderOpen class="w-4 h-4" aria-hidden="true" />{t("newInstanceLauncher.openAnotherProject")}
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </>
  )
}
