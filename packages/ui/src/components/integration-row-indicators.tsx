import { For, Show, splitProps, type JSX } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Tooltip } from "@kobalte/core/tooltip"
import { AlertTriangle, Link2, Unlink2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import type { IntegrationAttention } from "../lib/integration-row-state"
import type { IntegrationRowBinding } from "./integration-row-binding"

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

/**
 * The chain button of a native integration's row: pressed while the displayed conversation is attached. A click
 * detaches it, or attaches it to the only open document, or opens the choice between several documents.
 */
export function IntegrationLinkButton(props: { binding: IntegrationRowBinding }) {
  const { t } = useI18n()
  const link = () => props.binding.link()!
  const attached = () => link().state === "attached"
  const state = () => {
    const value = link()
    return value.state === "attached" ? t("integrations.link.attached", { label: value.label }) : t(`integrations.link.${value.state}`)
  }
  const action = () => {
    const next = props.binding.chainAction()
    return next === "detach" ? t("integrations.detachConversation") : next === "attach" ? t("integrations.attachConversation") : props.binding.unavailable() ?? ""
  }
  const disabled = () => props.binding.busy() || props.binding.chainAction() === "unavailable"
  return <DropdownMenu placement="bottom-end" gutter={4} open={props.binding.choices() !== undefined}
    onOpenChange={open => { if (!open) props.binding.closeChoices(); else if (!disabled()) void props.binding.activate() }}>
    <Tooltip placement="top" openDelay={300}>
      <DropdownMenu.Trigger as={Tooltip.Trigger} type="button" class="icon-button-compact icon-toggle plugin-control-link"
        data-integration-link={link().state} aria-pressed={attached()} aria-disabled={disabled() ? "true" : undefined}
        aria-busy={props.binding.busy()} aria-label={`${state()} — ${action()}`}>
        <Show when={link().state === "none"} fallback={<Link2 class="h-3.5 w-3.5" classList={{ "animate-pulse": props.binding.busy() }} aria-hidden="true" />}>
          <Unlink2 class="h-3.5 w-3.5" classList={{ "animate-pulse": props.binding.busy() }} aria-hidden="true" />
        </Show>
      </DropdownMenu.Trigger>
      <Tooltip.Portal><Tooltip.Content class="section-info-tooltip plugin-control-tooltip"><bdi>{state()}</bdi>{"\n"}{action()}</Tooltip.Content></Tooltip.Portal>
    </Tooltip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="action-overflow-content" data-integration-offers>
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel class="action-overflow-info">{t("integrations.attachChoose")}</DropdownMenu.GroupLabel>
          <For each={props.binding.choices() ?? []}>{offer => (
            <DropdownMenu.Item class="action-overflow-item" onSelect={() => void offer.attach()}>
              <span class="action-overflow-item-icon" aria-hidden="true"><Link2 class="h-3.5 w-3.5" /></span>
              <span class="action-overflow-item-label"><bdi>{offer.label}</bdi></span>
            </DropdownMenu.Item>
          )}</For>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu>
}

/** Shown only when the application part needs an action, named in the row menu. */
export function IntegrationAttentionIndicator(props: { attention: IntegrationAttention; app: string }) {
  const { t } = useI18n()
  return <Indicator label={t(`integrations.attention.${props.attention}`, { app: props.app })} data-integration-attention={props.attention}>
    <AlertTriangle class="h-3.5 w-3.5" aria-hidden="true" />
  </Indicator>
}
