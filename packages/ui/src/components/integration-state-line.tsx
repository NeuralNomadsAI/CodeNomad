import { For, Show } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Link2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import type { IntegrationStateLine } from "../lib/integration-row-state"
import type { IntegrationRowBinding } from "./integration-row-binding"

/**
 * The state line under an integration's name: muted text that informs, or an accent button that installs, updates,
 * attaches (directly or through the choice of documents) or detaches. Long text is truncated; the native `title`
 * holds it in full, and the accessible name carries it for keyboard and screen-reader users.
 */
export function IntegrationStateLineView(props: {
  line: IntegrationStateLine
  /** Absent for rows without a loaded integration: their line only informs. */
  binding?: IntegrationRowBinding
  install?: () => void
}) {
  const { t } = useI18n()
  const text = () => t(props.line.key, props.line.vars)
  const busy = () => props.binding?.busy() ?? false
  const hint = () => props.line.action === "detach" ? t("integrations.detachConversation") : undefined
  const run = () => {
    if (busy()) return
    const action = props.line.action
    if (action === "install" || action === "update") props.install?.()
    else if (action === "detach") void props.binding?.detach()
    else if (action === "attach") void props.binding?.activate(props.line.offerID)
  }
  const content = () => <>
    <Show when={props.line.action === "detach"}><Link2 class="h-3 w-3 shrink-0" aria-hidden="true" /></Show>
    <span class="plugin-control-state-text"><bdi>{text()}</bdi></span>
  </>
  return <div class="plugin-control-state" data-integration-state-line={props.line.key.split(".").pop()} data-tone={props.line.tone}>
    <Show when={props.binding && props.line.action} fallback={<span class="plugin-control-state-info" title={text()}>{content()}</span>}>
      <DropdownMenu placement="bottom-start" gutter={4} open={props.binding?.choices() !== undefined}
        onOpenChange={open => { if (!open) props.binding?.closeChoices(); else run() }}>
        <DropdownMenu.Trigger type="button" class="plugin-control-state-action" aria-busy={busy()} aria-disabled={busy() ? "true" : undefined}
          title={[text(), hint()].filter(Boolean).join("\n")} aria-label={[text(), hint()].filter(Boolean).join(" — ")}>
          {content()}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="action-overflow-content" data-integration-offers>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="action-overflow-info">{t("integrations.attachChoose")}</DropdownMenu.GroupLabel>
              <For each={props.binding?.choices() ?? []}>{offer => (
                <DropdownMenu.Item class="action-overflow-item" onSelect={() => void offer.attach()}>
                  <span class="action-overflow-item-icon" aria-hidden="true"><Link2 class="h-3.5 w-3.5" /></span>
                  <span class="action-overflow-item-label"><bdi>{offer.document ?? offer.label}</bdi></span>
                </DropdownMenu.Item>
              )}</For>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  </div>
}
