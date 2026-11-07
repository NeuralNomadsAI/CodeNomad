import { Show } from "solid-js"
import { GitBranch, Globe, Hourglass } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { openSettingsRow } from "../stores/settings-screen"

interface NewTabActionsProps {
  isLoading: boolean
  onClone: () => void
  onNewTemporary?: () => void
  hideSidecar?: boolean
  home?: boolean
}

/** Secondary creation actions inside the canonical project selector. */
export default function NewTabActions(props: NewTabActionsProps) {
  const { t } = useI18n()
  const Action = (action: { label: string; icon: typeof Globe; onClick: () => void; title?: string }) => (
    <button type="button" class={props.home ? "button-primary w-full flex items-center justify-center gap-2 text-sm disabled:cursor-not-allowed" : "window-action"} disabled={props.isLoading} title={action.title ?? action.label}
      onClick={() => { if (!props.isLoading) action.onClick() }}>
      <action.icon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{action.label}</span>
    </button>
  )
  return (
    <>
      <Action label={t("folderSelection.clone.button")} icon={GitBranch} onClick={props.onClone} />
      <Show when={props.onNewTemporary}>
        {(onNewTemporary) => <Action label={t("folderSelection.temporary.button")} icon={Hourglass}
          title={t("folderSelection.temporary.description")} onClick={() => onNewTemporary()()} />}
      </Show>
      <Show when={!props.hideSidecar}>
        <Action label={t("folderSelection.newSidecar")} icon={Globe} onClick={() => void openSettingsRow("sidecars", "sidecar-add")} />
      </Show>
    </>
  )
}
