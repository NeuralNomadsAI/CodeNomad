import { Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { recentOpenElsewhere, type LaunchableRecent } from "../lib/recent-open-target"

export default function RecentOpenElsewhere(props: { recent: LaunchableRecent }) {
  const { t } = useI18n()
  const label = () => t("folderSelection.recent.openElsewhere")
  return <Show when={recentOpenElsewhere(props.recent)}>
    <span class="status-dot ready inline-block shrink-0 pointer-events-auto" role="img" aria-label={label()} title={label()} />
  </Show>
}
