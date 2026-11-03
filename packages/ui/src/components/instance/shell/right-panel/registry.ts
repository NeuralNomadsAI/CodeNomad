import type { JSX } from "solid-js"

export interface RightPanelItem {
  id: string
  labelKey: string
  /** External author label; never registered in the application's i18n catalogue. */
  label?: string
  order: number
  alwaysVisible?: boolean
  /** Without a saved rank, placed after this item and the items of the same anchor that directly follow it. */
  after?: string
}

export interface RightPanelTabModule extends RightPanelItem {
  render: () => JSX.Element
}

export interface RightPanelSectionModule extends RightPanelItem {
  tooltipKey: string
  /** External tooltip text; never registered in the application's i18n catalogue. */
  tooltip?: string
  defaultExpanded?: boolean
  /** Non-interactive inline content, shown only while collapsed. */
  renderSummary?: () => JSX.Element
  /** Non-interactive state shown inside the trigger, collapsed or expanded. */
  renderStatus?: () => JSX.Element
  /** Controls placed before the section's information button. */
  renderHeaderActions?: () => JSX.Element
  /** Replaces the tooltip information button. */
  renderInfo?: () => JSX.Element
  /** Accessible name of the section's region, when it differs from the trigger's text. */
  regionLabel?: string
  /** A changed key expands once; undefined clears it, null retains it while a read is pending. */
  autoExpandKey?: () => string | undefined | null
  render: () => JSX.Element
}

export interface RightPanelModule {
  id: string
  displayNameKey: string
  descriptionKey?: string
  origin: "first-party" | "external"
  tabs?: readonly RightPanelTabModule[]
  statusSections?: readonly RightPanelSectionModule[]
  /** Rendered once by the Status tab while it is shown, for shared windows and announcements. */
  renderStatusExtras?: () => JSX.Element
}

export interface RightPanelCustomization {
  tabOrder: string[]
  hiddenTabIds: string[]
  statusSectionOrder: string[]
  hiddenStatusSectionIds: string[]
}

export const DEFAULT_RIGHT_PANEL_CUSTOMIZATION: RightPanelCustomization = {
  tabOrder: [],
  hiddenTabIds: [],
  statusSectionOrder: [],
  hiddenStatusSectionIds: [],
}

export function parseRightPanelCustomization(value: string | null): RightPanelCustomization {
  if (!value) return { ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION }
  try {
    const parsed = JSON.parse(value) as Partial<RightPanelCustomization>
    return {
      tabOrder: readStringArray(parsed.tabOrder),
      hiddenTabIds: readStringArray(parsed.hiddenTabIds),
      statusSectionOrder: readStringArray(parsed.statusSectionOrder),
      hiddenStatusSectionIds: readStringArray(parsed.hiddenStatusSectionIds),
    }
  } catch {
    return { ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION }
  }
}

export function collectRightPanelItems<T extends RightPanelItem>(modules: readonly RightPanelModule[], key: "tabs" | "statusSections"): T[] {
  const items = modules.flatMap((module) => [...((module[key] ?? []) as unknown as readonly T[])])
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.id) throw new Error(`Right panel ${key} must define an id`)
    if (seen.has(item.id)) throw new Error(`Duplicate right panel ${key} id: ${item.id}`)
    seen.add(item.id)
  }
  return sortRightPanelItems(items, [])
}

export function applyRightPanelItemCustomization<T extends RightPanelItem>(
  items: readonly T[],
  orderedIds: readonly string[],
  hiddenIds: readonly string[],
): T[] {
  const hidden = new Set(hiddenIds)
  // Sort before hiding, so an unranked item keeps its anchor while the anchor is hidden.
  const sorted = sortRightPanelItems(items, orderedIds)
  const visible = sorted.filter((item) => item.alwaysVisible || !hidden.has(item.id))
  return visible.length > 0 ? visible : sortRightPanelItems(items.slice(0, 1), orderedIds)
}

/**
 * Moves only `sourceId` next to `targetId` (before it when moving up, after it when moving down) in the saved order.
 * `displayedIds` is the shown order; saved IDs it does not show (unknown, hidden or momentarily absent) keep their place.
 */
export function reorderStatusSections(orderedIds: readonly string[], displayedIds: readonly string[], sourceId: string, targetId: string): string[] {
  const order = materializeOrder(orderedIds, displayedIds)
  const sourceIndex = displayedIds.indexOf(sourceId)
  const targetIndex = displayedIds.indexOf(targetId)
  if (sourceIndex === -1 || targetIndex === -1 || sourceId === targetId) return order
  const next = order.filter((id) => id !== sourceId)
  const at = next.indexOf(targetId)
  next.splice(sourceIndex < targetIndex ? at + 1 : at, 0, sourceId)
  return next
}

/** Keyboard reorder: swaps `id` with its shown neighbour, through the same algorithm as dragging. */
export function moveRightPanelItem(orderedIds: readonly string[], displayedIds: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = displayedIds.indexOf(id)
  const target = displayedIds[index + direction]
  if (index === -1 || target === undefined) return materializeOrder(orderedIds, displayedIds)
  return reorderStatusSections(orderedIds, displayedIds, id, target)
}

export function setRightPanelItemHidden(hiddenIds: readonly string[], id: string, hidden: boolean): string[] {
  const next = new Set(hiddenIds)
  if (hidden) next.add(id)
  else next.delete(id)
  return [...next]
}

function sortRightPanelItems<T extends RightPanelItem>(items: readonly T[], orderedIds: readonly string[]): T[] {
  const byDefault = [...items].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const rank = new Map(orderedIds.map((id, index) => [id, index]))
  if (!byDefault.some((item) => rank.has(item.id))) return byDefault
  const ranked = byDefault.filter((item) => rank.has(item.id)).sort((left, right) => rank.get(left.id)! - rank.get(right.id)!)
  const unranked = byDefault.filter((item) => !rank.has(item.id))
  const result = [...ranked, ...unranked.filter((item) => !item.after)]
  for (const item of unranked.filter((entry) => entry.after)) {
    const anchor = result.findIndex((entry) => entry.id === item.after)
    if (anchor === -1) { result.push(item); continue }
    let at = anchor + 1
    while (at < result.length && result[at]!.after === item.after) at++
    result.splice(at, 0, item)
  }
  return result
}

/** The saved order with each shown ID it lacks inserted after its shown predecessor. */
function materializeOrder(orderedIds: readonly string[], displayedIds: readonly string[]): string[] {
  const order = orderedIds.filter((id, index) => orderedIds.indexOf(id) === index)
  displayedIds.forEach((id, index) => {
    if (order.includes(id)) return
    const previous = displayedIds.slice(0, index).reverse().find((entry) => order.includes(entry))
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, id)
  })
  return order
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}
