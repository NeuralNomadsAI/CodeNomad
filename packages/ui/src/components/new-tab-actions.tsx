import { Show } from "solid-js"
import { GitBranch, Globe, Hourglass, Server } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { openRemoteServerEditor } from "../stores/remote-server-editor"
import { openSettingsRow } from "../stores/settings-screen"

interface NewTabActionsProps {
  isLoading: boolean
  /** The home page's full-width buttons, or the launcher's compact ones. */
  variant: "home" | "launcher"
  onClone: () => void
  onNewTemporary?: () => void
  /** Called before an action runs, e.g. to dismiss the launcher. */
  onRun?: () => void
}

/**
 * The creation buttons shared by the home page and the launcher: clone a
 * repository, a temporary tab, a CodeNomad server (host windows only, through
 * the server dialog) and a SideCar (its form in Settings → SideCars).
 */
export default function NewTabActions(props: NewTabActionsProps) {
  const { t } = useI18n()
  const buttonClass = () => props.variant === "home"
    ? "button-primary w-full flex items-center justify-center gap-2 text-sm disabled:cursor-not-allowed"
    : "window-action"

  function run(action: () => void) {
    if (props.isLoading) return
    props.onRun?.()
    action()
  }

  const Action = (action: { label: string; icon: typeof Globe; onClick: () => void; title?: string; disabled?: boolean }) => (
    <button type="button" class={buttonClass()} disabled={action.disabled ?? props.isLoading} title={action.title ?? action.label}
      onClick={() => run(action.onClick)}>
      <action.icon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{action.label}</span>
    </button>
  )

  return (
    <>
      <Action label={t("folderSelection.clone.button")} icon={GitBranch} onClick={props.onClone} />
      <Show when={props.onNewTemporary}>
        {(onNewTemporary) => (
          <Action label={t("folderSelection.temporary.button")} icon={Hourglass} title={t("folderSelection.temporary.description")}
            onClick={() => onNewTemporary()()} />
        )}
      </Show>
      <Show when={canOpenRemoteWindows()}>
        <Action label={t("folderSelection.newServer")} icon={Server} onClick={() => openRemoteServerEditor()} />
      </Show>
      <Action label={t("folderSelection.newSidecar")} icon={Globe} onClick={() => void openSettingsRow("sidecars", "sidecar-add")} />
    </>
  )
}
