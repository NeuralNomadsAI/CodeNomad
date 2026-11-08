import { Popover } from "@kobalte/core/popover"
import { useI18n } from "../lib/i18n"
import { Hourglass } from "lucide-solid"
import RecentTabsMenu from "./recent-tabs-menu"

interface NewInstanceLauncherProps {
  open: boolean
  anchor?: HTMLElement
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onNewTemporary: () => void
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
              if (!content?.contains(document.activeElement) || document.activeElement === content) content?.querySelector<HTMLElement>(".recent-tabs-menu")?.focus()
            }}
            onEscapeKeyDown={(event) => {
              if ((event.target as HTMLElement)?.closest("[data-remote-view-session]")) event.preventDefault()
              else returnFocus = true
            }} onCloseAutoFocus={(event) => {
              event.preventDefault()
              const active = document.activeElement
              if (returnFocus && !props.open && (!active || active === document.body || content?.contains(active))) props.anchor?.focus()
              returnFocus = false
            }}>
            <header class="window-header">
              <Popover.Title class="window-title">{t("newInstanceLauncher.title")}</Popover.Title>
              <button type="button" class="window-icon-button !border !border-solid !border-base" disabled={props.isLoading}
                aria-label={t("folderSelection.temporary.button")} title={t("folderSelection.temporary.button")}
                onClick={() => { if (!props.isLoading) { close(); props.onNewTemporary() } }}>
                <Hourglass aria-hidden="true" />
              </button>
            </header>
            <Popover.Description class="sr-only">{t("newInstanceLauncher.description")}</Popover.Description>
            <RecentTabsMenu active={props.open} isLoading={props.isLoading} onRun={close}
              onSelectFolder={props.onSelectFolder} onSelectExistingInstance={props.onSelectExistingInstance} />
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </>
  )
}
