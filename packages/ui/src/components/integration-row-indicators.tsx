import { Show, splitProps, type JSX } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { AlertTriangle, Link2, Unlink2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import type { IntegrationAttention, IntegrationLink } from "../lib/integration-row-state"

/** A focusable icon whose text is its accessible name and its tooltip. */
function Indicator(props: { label: string; children: JSX.Element } & Record<`data-${string}`, string | undefined>) {
  const [, data] = splitProps(props, ["label", "children"])
  return <Tooltip placement="top" openDelay={300}>
    <Tooltip.Trigger as="span" tabindex="0" role="img" class="plugin-control-indicator" aria-label={props.label} {...data}>
      {props.children}
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content class="section-info-tooltip plugin-control-tooltip"><bdi>{props.label}</bdi></Tooltip.Content></Tooltip.Portal>
  </Tooltip>
}

/** Linked or broken chain: whether the displayed conversation is attached to the integration's application. */
export function IntegrationLinkIndicator(props: { link: IntegrationLink }) {
  const { t } = useI18n()
  const label = () => props.link.state === "attached" ? t("integrations.link.attached", { label: props.link.label }) : t(`integrations.link.${props.link.state}`)
  return <Indicator label={label()} data-integration-link={props.link.state}>
    <Show when={props.link.state === "none"} fallback={<Link2 class="h-3.5 w-3.5" aria-hidden="true" />}>
      <Unlink2 class="h-3.5 w-3.5" aria-hidden="true" />
    </Show>
  </Indicator>
}

/** Shown only when the application part needs an action, named in the row menu. */
export function IntegrationAttentionIndicator(props: { attention: IntegrationAttention; app: string }) {
  const { t } = useI18n()
  return <Indicator label={t(`integrations.attention.${props.attention}`, { app: props.app })} data-integration-attention={props.attention}>
    <AlertTriangle class="h-3.5 w-3.5" aria-hidden="true" />
  </Indicator>
}
