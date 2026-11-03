import { For, createSignal } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Blocks, Package, Plus } from "lucide-solid"
import type { PluginControlLocation } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { IntegrationCatalogWindow } from "./integration-catalog-window"
import { PluginSourceAdd } from "./plugin-source-add"

type Item = { kind: "integration" | "plugin" }
// Stable descriptors: icons are created by the item renderer, once per rendered item.
const ITEMS: readonly Item[] = [{ kind: "integration" }, { kind: "plugin" }]

/** The Plugins "+" menu: "Add an integration…" (the reviewed catalogue) and "Add a plugin…" (any package). */
export function PluginAddMenu(props: {
  instanceId: string
  location: PluginControlLocation
  projectAvailable: boolean
  active?: boolean
  sessionId?: string
}) {
  const { t } = useI18n()
  const [plugin, setPlugin] = createSignal(false)
  const [catalog, setCatalog] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let afterClose: (() => void) | undefined
  const label = (item: Item) => t(item.kind === "integration" ? "integrations.add" : "instanceServiceStatus.plugins.sources.addPlugin")
  return <>
    <DropdownMenu placement="bottom-start" gutter={4}>
      <DropdownMenu.Trigger ref={trigger} type="button" class="icon-button-compact" disabled={props.active === false}
        title={t("instanceServiceStatus.plugins.sources.add")} aria-label={t("instanceServiceStatus.plugins.sources.add")}>
        <Plus class="h-3.5 w-3.5" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal mount={trigger?.closest<HTMLElement>(".session-floating-drawer") ?? undefined}>
        <DropdownMenu.Content class="action-overflow-content" onCloseAutoFocus={event => {
          const action = afterClose; afterClose = undefined
          if (!action) return
          // The next window takes focus; never hand it back to the trigger first.
          event.preventDefault()
          queueMicrotask(action)
        }}>
          <For each={ITEMS}>{item => (
            <DropdownMenu.Item class="action-overflow-item" disabled={props.active === false}
              onSelect={() => { afterClose = () => (item.kind === "integration" ? setCatalog : setPlugin)(true) }}>
              <span class="action-overflow-item-icon" aria-hidden="true">
                {item.kind === "integration" ? <Blocks class="h-3.5 w-3.5" /> : <Package class="h-3.5 w-3.5" />}
              </span>
              <span class="action-overflow-item-label">{label(item)}</span>
            </DropdownMenu.Item>
          )}</For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <PluginSourceAdd instanceId={props.instanceId} location={props.location} projectAvailable={props.projectAvailable} active={props.active}
      open={plugin()} onOpenChange={setPlugin} anchor={() => trigger} />
    <IntegrationCatalogWindow instanceId={props.instanceId} location={props.location} projectAvailable={props.projectAvailable}
      active={props.active} sessionId={props.sessionId} open={catalog()} onClose={() => setCatalog(false)} trigger={() => trigger} />
  </>
}
