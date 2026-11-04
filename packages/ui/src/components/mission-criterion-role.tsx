import { Tooltip } from "@kobalte/core/tooltip"
import { Filter, Zap } from "lucide-solid"
import { For } from "solid-js"
import { useI18n } from "../lib/i18n"

/** An event card's role: a trigger ("When") or a condition ("Only if"). Two pressed
 * icon toggles; each one names its role and explains it in a hover/focus tooltip. */
export function MissionCriterionRole(props: { onlyIf: boolean; label: string; onChange: (onlyIf: boolean) => void }) {
  const { t } = useI18n()
  const roles = [{ onlyIf: false, key: "when", Icon: Zap }, { onlyIf: true, key: "onlyIf", Icon: Filter }] as const
  return <div class="mission-criterion-role" role="group" aria-label={props.label}>
    <For each={roles}>{role => <Tooltip openDelay={200} gutter={4} placement="top">
      <Tooltip.Trigger as="button" type="button" class="window-icon-button icon-toggle" aria-pressed={props.onlyIf === role.onlyIf}
        aria-label={t(`missions.scheduling.role.${role.key}`)} onClick={() => props.onChange(role.onlyIf)}>
        <role.Icon class="h-3.5 w-3.5" aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content class="section-info-tooltip">{t(`missions.scheduling.role.${role.key}Hint`)}</Tooltip.Content></Tooltip.Portal>
    </Tooltip>}</For>
  </div>
}
