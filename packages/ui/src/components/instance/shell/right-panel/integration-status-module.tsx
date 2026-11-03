import { Show, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { integrationAutoExpandKey } from "../../../integration-section-state"
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

/** Status announcements closer than this are read as one. */
export const INTEGRATION_ANNOUNCE_DELAY_MS = 500

/**
 * One Status section per recognised integration of the instance's Location, in catalogue order after Plugins, and
 * the single attachment (picker, bindings, receipts) of the displayed conversation that they share.
 */
export function createIntegrationStatusModule(options: IntegrationStatusModuleOptions): Accessor<RightPanelModule> {
  let statusMarker: HTMLDivElement | undefined
  const pluginsTrigger = () => {
    const root = statusMarker?.closest(".status-tab-container")
    return root?.isConnected ? root.querySelector<HTMLElement>('[data-status-section-trigger="plugins"]')
      ?? root.querySelector<HTMLElement>("[data-status-section-trigger]") : undefined
  }
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
  // One polite region per Status tab: changes are grouped, never announced per event.
  const [announcement, setAnnouncement] = createSignal("")
  let queued: string[] = []
  let announceTimer: ReturnType<typeof setTimeout> | undefined
  const announce = (message: string) => {
    queued.push(message)
    clearTimeout(announceTimer)
    announceTimer = setTimeout(() => { setAnnouncement(queued.join(" ")); queued = [] }, INTEGRATION_ANNOUNCE_DELAY_MS)
  }
  onCleanup(() => clearTimeout(announceTimer))
  const attachment = createIntegrationAttachment({
    instanceId: options.instanceId,
    get directory() { return directory() },
    get session() { return session() },
    get active() { return options.isActive() },
    onMessage: announce,
    focusFallback: () => pluginsTrigger(),
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
    const known = cache.get(id)
    if (known) return known
    const value: RightPanelSectionModule = {
      id: integrationSectionId(id),
      labelKey: "",
      get label() { return entry(id)?.displayName ?? id },
      get regionLabel() { return entry(id)?.displayName ?? id },
      tooltipKey: "",
      get order() { return INTEGRATION_SECTION_ORDER + ids().indexOf(id) / 1000 },
      after: "plugins",
      renderStatus: () => <Show when={facts(id)}>{value => <IntegrationSectionStatus t={options.t} state={value().state} />}</Show>,
      renderHeaderActions: () => <IntegrationDocsButton t={options.t} docs={entry(id)?.docs} />,
      renderInfo: () => <Show when={entry(id)}>{value => <IntegrationInfoButton t={options.t} entry={value()} state={facts(id)!.state} />}</Show>,
      autoExpandKey: () => {
        const value = facts(id), key = value && integrationAutoExpandKey(value.state)
        const conversation = value?.state.conversation?.state
        if (!key && (conversation === "unknown" || conversation === "uncertain")) return null
        return key === "attached" ? `${key}:${session()?.id}` : key
      },
      render: () => <IntegrationSection t={options.t} entry={() => entry(id)} context={context} />,
    }
    cache.set(id, value)
    return value
  }
  const sections = createMemo(() => ids().map(section))

  // Appearances, disappearances and label changes, after the first read of a Location.
  let known: Map<string, string> | undefined
  const names = new Map<string, string>()
  const labels = createMemo(() => ids().map(id => `${id}\0${facts(id)?.state.label ?? ""}`).join("\n"))
  createEffect(on(directory, () => { known = undefined }, { defer: true }))
  createEffect(on(labels, value => {
    if (!response()) return
    for (const item of untrack(response)!.integrations) names.set(item.id, item.displayName)
    const current = new Map(value ? value.split("\n").map(line => line.split("\0") as [string, string]) : [])
    if (known) {
      for (const [id, label] of current) {
        const name = names.get(id) ?? id
        if (!known.has(id)) announce(options.t("integrations.announce.added", { name }))
        else if (known.get(id) !== label && label) announce(options.t("integrations.announce.state", { name, state: options.t(`integrations.state.${label}`) }))
      }
      for (const id of known.keys()) if (!current.has(id)) announce(options.t("integrations.announce.removed", { name: names.get(id) ?? id }))
    }
    known = current
  }))

  // A section that disappears with focus inside hands it to the Plugins trigger, without any mutation.
  let focusedSection: string | undefined
  const trackFocus = (event: FocusEvent) => {
    focusedSection = (event.target as Element | null)?.closest?.("[data-status-section]")?.getAttribute("data-status-section") ?? undefined
  }
  document.addEventListener("focusin", trackFocus)
  onCleanup(() => document.removeEventListener("focusin", trackFocus))
  createEffect(on(ids, (current, previous) => {
    const lost = focusedSection && previous?.some(id => integrationSectionId(id) === focusedSection && !current.includes(id))
    if (!lost) return
    queueMicrotask(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) pluginsTrigger()?.focus()
    })
  }, { defer: true }))

  const renderStatusExtras = () => <>
    {attachment.picker()}
    <div ref={statusMarker} class="sr-only" role="status" aria-live="polite" data-integration-announcements>{announcement()}</div>
  </>
  return createMemo<RightPanelModule>(() => ({
    id: "integration-status",
    displayNameKey: "",
    origin: "first-party",
    statusSections: sections(),
    renderStatusExtras,
  }))
}
