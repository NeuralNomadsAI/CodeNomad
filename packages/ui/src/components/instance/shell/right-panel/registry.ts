import type { JSX } from "solid-js"

export interface RightPanelItem {
  id: string
  labelKey: string
  order: number
  alwaysVisible?: boolean
}

export interface RightPanelTabModule extends RightPanelItem {
  render: () => JSX.Element
}

export interface RightPanelSectionModule extends RightPanelItem {
  tooltipKey: string
  defaultExpanded?: boolean
  render: () => JSX.Element
}

export interface RightPanelModule {
  id: string
  displayNameKey: string
  descriptionKey?: string
  origin: "first-party"
  tabs?: readonly RightPanelTabModule[]
  statusSections?: readonly RightPanelSectionModule[]
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
  const visible = items.filter((item) => item.alwaysVisible || !hidden.has(item.id))
  return sortRightPanelItems(visible.length > 0 ? visible : items.slice(0, 1), orderedIds)
}

export function moveRightPanelItem(orderedIds: readonly string[], allIds: readonly string[], id: string, direction: -1 | 1): string[] {
  const order = normalizeOrder(orderedIds, allIds)
  const index = order.indexOf(id)
  const nextIndex = index + direction
  if (index === -1 || nextIndex < 0 || nextIndex >= order.length) return order
  const next = [...order]
  ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
  return next
}

export function setRightPanelItemHidden(hiddenIds: readonly string[], id: string, hidden: boolean): string[] {
  const next = new Set(hiddenIds)
  if (hidden) next.add(id)
  else next.delete(id)
  return [...next]
}

export function getRightPanelTabNavigationTarget<T extends RightPanelItem>(items: readonly T[], currentId: string, key: string): T | undefined {
  const index = items.findIndex((item) => item.id === currentId)
  if (index === -1) return
  if (key === "Home") return items[0]
  if (key === "End") return items[items.length - 1]
  if (key === "ArrowLeft" || key === "ArrowUp") return items[(index - 1 + items.length) % items.length]
  if (key === "ArrowRight" || key === "ArrowDown") return items[(index + 1) % items.length]
}

function sortRightPanelItems<T extends RightPanelItem>(items: readonly T[], orderedIds: readonly string[]): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]))
  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.id)
    const rightRank = rank.get(right.id)
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER)
    }
    return left.order - right.order || left.id.localeCompare(right.id)
  })
}

function normalizeOrder(orderedIds: readonly string[], allIds: readonly string[]): string[] {
  const known = new Set(allIds)
  const ordered = orderedIds.filter((id, index) => known.has(id) && orderedIds.indexOf(id) === index)
  return [...ordered, ...allIds.filter((id) => !ordered.includes(id))]
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}
