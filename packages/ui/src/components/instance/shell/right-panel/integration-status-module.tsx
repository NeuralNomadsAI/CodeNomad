import { Show, createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import type { IntegrationView } from "../../../../../../server/src/integration-types"
import { integrations } from "../../../../stores/integrations"
import { pluginControlsCache } from "../../../../stores/plugin-controls"
import { createIntegrationAttachment } from "../../../integration-attachment"
import { createIntegrationContext } from "../../../integration-context"
import { createIntegrationHostInstallation } from "../../../integration-host-installation"
import {
  IntegrationDocsButton,
  IntegrationInfoButton,
  IntegrationSection,
  IntegrationSectionStatus,
  integrationSectionFacts,
  type IntegrationSectionContext,
} from "../../../integration-section"
import { INTEGRATION_SECTION_ORDER, integrationSectionId, integrationSectionIds } from "./integration-sections"
import type { RightPanelModule, RightPanelSectionModule } from "./registry"
import "../../../../stores/plugin-controls-events"

interface IntegrationStatusModuleOptions {
  instanceId: string
  folder: Accessor<string>
  t: (key: string, vars?: Record<string, any>) => string
  /** True only while the panel is visible with the Status tab selected. */
  isActive: Accessor<boolean>
}

const pluginsTrigger = (from?: Element | null) =>
  (from?.closest(".status-tab-container") ?? document).querySelector<HTMLElement>('[data-status-section-trigger="plugins"]')

/**
 * One Status section per recognised integration of the instance's Location, in catalogue order after Plugins, and
 * the single attachment (picker, bindings, receipts) of the displayed conversation that they share.
 */
export function createIntegrationStatusModule(options: IntegrationStatusModuleOptions): Accessor<RightPanelModule> {
  const { location, session } = createIntegrationContext(() => options.instanceId, options.folder)
  const directory = () => location().directory
  const response = createMemo(() => {
    const state = integrations.state(options.instanceId, directory())
    return state.status === "ready" ? state.response : undefined
  })
  createEffect(on(() => [options.isActive(), directory()] as const, ([active, value]) => {
    if (!active || !value) return
    onCleanup(integrations.demand(options.instanceId, value))
    onCleanup(pluginControlsCache.acquireDemand(options.instanceId, { directory: value }))
  }))
  const attachment = createIntegrationAttachment({
    instanceId: options.instanceId,
    get directory() { return directory() },
    get session() { return session() },
    get active() { return options.isActive() },
  })
  const installation = createIntegrationHostInstallation({
    instanceId: options.instanceId,
    get directory() { return directory() },
    get sessionId() { return session()?.id },
    get active() { return options.isActive() },
    entries: attachment.entries,
  })
  const context: IntegrationSectionContext = {
    instanceId: options.instanceId, location, session, active: options.isActive, attachment, installation,
    pluginsTrigger: () => pluginsTrigger(),
  }
  const entry = (id: string): IntegrationView | undefined => response()?.integrations.find(item => item.id === id)
  const facts = (id: string) => { const value = entry(id); return value ? integrationSectionFacts(context, value) : undefined }
  const ids = createMemo(() => integrationSectionIds(response()?.integrations ?? []),
    [], { equals: (left, right) => left.length === right.length && left.every((id, index) => id === right[index]) })

  // Stable section objects: a refresh never remounts a shown section.
  const cache = new Map<string, RightPanelSectionModule>()
  const section = (id: string, index: number): RightPanelSectionModule => {
    const order = INTEGRATION_SECTION_ORDER + index / 1000
    const known = cache.get(id)
    if (known && known.order === order) return known
    const value: RightPanelSectionModule = {
      id: integrationSectionId(id),
      labelKey: "",
      get label() { return entry(id)?.displayName ?? id },
      get regionLabel() { return entry(id)?.displayName ?? id },
      tooltipKey: "",
      order,
      after: "plugins",
      renderStatus: () => <Show when={facts(id)}>{value => <IntegrationSectionStatus t={options.t} state={value().state} />}</Show>,
      renderHeaderActions: () => <IntegrationDocsButton t={options.t} docs={entry(id)?.docs} />,
      renderInfo: () => <Show when={entry(id)}>{value => <IntegrationInfoButton t={options.t} entry={value()} state={facts(id)!.state} />}</Show>,
      render: () => <IntegrationSection t={options.t} entry={() => entry(id)} context={context} />,
    }
    cache.set(id, value)
    return value
  }
  const sections = createMemo(() => ids().map(section))

  return createMemo<RightPanelModule>(() => ({
    id: "integration-status",
    displayNameKey: "",
    origin: "first-party",
    statusSections: sections(),
    renderStatusExtras: () => attachment.picker(),
  }))
}
