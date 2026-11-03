import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { integrations } from "../../../../stores/integrations"
import { createIntegrationContext } from "../../../integration-context"
import { IntegrationSection } from "../../../integration-section"
import { INTEGRATION_SECTION_ORDER, integrationSectionId, integrationSectionIds } from "./integration-sections"
import type { RightPanelModule, RightPanelSectionModule } from "./registry"

interface IntegrationStatusModuleOptions {
  instanceId: string
  folder: Accessor<string>
  t: (key: string, vars?: Record<string, any>) => string
  /** True only while the panel is visible with the Status tab selected. */
  isActive: Accessor<boolean>
}

/** One Status section per recognised integration of the instance's Location, in catalogue order after Plugins. */
export function createIntegrationStatusModule(options: IntegrationStatusModuleOptions): Accessor<RightPanelModule> {
  const context = createIntegrationContext(() => options.instanceId, options.folder)
  const directory = () => context.location().directory
  const response = createMemo(() => {
    const state = integrations.state(options.instanceId, directory())
    return state.status === "ready" ? state.response : undefined
  })
  createEffect(on(() => [options.isActive(), directory()] as const, ([active, location]) => {
    if (active && location) onCleanup(integrations.demand(options.instanceId, location))
  }))
  const entry = (id: string) => response()?.integrations.find(item => item.id === id)
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
      get tooltip() { return entry(id)?.displayName ?? id },
      order,
      after: "plugins",
      render: () => <IntegrationSection t={options.t} entry={() => entry(id)} />,
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
  }))
}
