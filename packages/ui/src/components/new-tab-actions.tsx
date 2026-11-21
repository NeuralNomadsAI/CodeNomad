import { Show } from "solid-js"
import { GitBranch, Globe, Hourglass } from "lucide-solid"
import { hostSupports } from "../lib/backend-capabilities"
import { useI18n } from "../lib/i18n"
import { openSettingsRow } from "../stores/settings-screen"

interface NewTabActionsProps {
  isLoading: boolean
  onClone: () => void
  onNewTemporary?: () => void
  blank?: boolean
}

/** Secondary creation actions inside the canonical project selector. */
export default function NewTabActions(props: NewTabActionsProps) {
  const { t } = useI18n()
  const Action = (action: { label: string; icon: typeof Globe; onClick: () => void; title?: string }) => (
    <button type="button" class={props.blank ? "window-action" : "button-primary w-full flex items-center justify-center gap-2 text-sm disabled:cursor-not-allowed"} disabled={props.isLoading} title={action.title ?? action.label}
      onClick={() => { if (!props.isLoading) action.onClick() }}>
      <action.icon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{action.label}</span>
    </button>
  )
  // Hosts that leave a route family undeclared hide its actions.
  const Temporary = () => <Show when={hostSupports("temporary-workspaces") && props.onNewTemporary}>
    {(onNewTemporary) => <Action label={t(props.blank ? "newTab.temporary" : "folderSelection.temporary.button")} icon={Hourglass}
      title={t("folderSelection.temporary.description")} onClick={() => onNewTemporary()()} />}
  </Show>
  return (
    <>
      <Show when={props.blank}><Temporary /></Show>
      <Show when={hostSupports("workspace-clone")}>
        <Action label={t(props.blank ? "folderSelection.clone.dialog.clone" : "folderSelection.clone.button")} title={t("folderSelection.clone.button")} icon={GitBranch} onClick={props.onClone} />
      </Show>
      <Show when={!props.blank}><Temporary /></Show>
      <Show when={!props.blank && hostSupports("sidecars")}>
        <Action label={t("folderSelection.newSidecar")} icon={Globe} onClick={() => void openSettingsRow("sidecars", "sidecar-add")} />
      </Show>
    </>
  )
}
