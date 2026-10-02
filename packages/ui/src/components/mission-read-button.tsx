import { Eye } from "lucide-solid"
import { useI18n } from "../lib/i18n"

/** One reader gesture for objectives, briefs, reports and plan changes. */
export function MissionReadButton(props: { onClick: () => void; label?: string }) {
  const { t } = useI18n()
  const label = () => props.label ?? t("missions.control.read")
  return <button type="button" class="mission-control-icon-button mission-read-button"
    aria-label={label()} title={label()} onClick={props.onClick}>
    <Eye class="h-3.5 w-3.5" aria-hidden="true" />
  </button>
}
