import type { Locator, Page } from "playwright"

/** Exercise a `MissionListItem` action through its inline or measured-overflow presentation
 * (cleanup receipts and other shared list rows; the Mission picker has no row menus). */
export async function clickListItemAction(row: Locator, label: string): Promise<void> {
  const button = row.getByRole("button", { name: label, exact: true })
  if (await button.isVisible()) {
    await button.click()
    return
  }
  await row.getByRole("button", { name: "More actions", exact: true }).click()
  await row.page().getByRole("menuitem", { name: label, exact: true }).click()
}

/** The selected Mission's detail: the selected row's children in the tree. */
export const missionDetail = (page: Page) => page.locator("section.mission-detail")

/** The panel header: general toolbar (create, settings, refresh), then the selection line. */
export const missionPicker = (page: Page) => page.locator(".mission-control .mission-picker")
/** The tree of Missions and schedules below the header. */
export const missionRows = (page: Page) => page.locator(".mission-control .mission-rows")
/** Title of the currently selected Mission/schedule's row. */
export const selectedMissionTitle = (page: Page) => missionRows(page).locator(".mission-row-select[aria-current=true] .session-item-title")

/** The general toolbar buttons above the selection line. */
export const missionGeneralAction = (page: Page, label: string) =>
  missionPicker(page).locator(".mission-picker-actions").getByRole("button", { name: label, exact: true })

/** The explicit panel refresh: read-only reconciliation, then resend of a still unconfirmed control. */
export const missionRefresh = (page: Page) => missionPicker(page).locator(".mission-picker-actions > button").last()

const exact = (title: string | RegExp) => typeof title === "string"
  ? new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) : title
const titleFilter = (page: Page, title: string | RegExp) => page.locator(".session-item-title", { hasText: exact(title) })

/** A row's select button for a title. */
export async function inlineMissionEntry(page: Page, title: string | RegExp): Promise<Locator> {
  return missionRows(page).locator("button.mission-row-select").filter({ has: titleFilter(page, title) })
}

/** The entry's screen-reader status (state, attention, relative time / schedule), read from its row. */
export async function missionEntryStatus(page: Page, title: string | RegExp): Promise<string> {
  const entry = await inlineMissionEntry(page, title)
  return (await entry.locator(".sr-only").textContent()) ?? ""
}

/** Select a Mission/schedule by title through its row and wait for its detail. */
export async function selectMission(page: Page, title: string | RegExp): Promise<Locator> {
  const entry = await inlineMissionEntry(page, title)
  // Often the first wait after navigation: allow for a cold page boot late in a long serial run.
  await entry.waitFor({ timeout: 60_000 })
  if (await entry.getAttribute("aria-current") !== "true") await entry.click()
  const detail = missionDetail(page)
  await detail.waitFor()
  return detail
}

/** The selected item's icon toolbar, mounted in the header's selection line. */
export const missionToolbar = (page: Page) => missionPicker(page).locator(".mission-picker-selection-actions .mission-action-bar")

/** A button of the selected item's icon toolbar (Play/Pause, Stop, Run now, Summary, Open conversation, Delete). */
export const missionToolbarAction = (page: Page, label: string) =>
  missionToolbar(page).getByRole("button", { name: label, exact: true })

/** The selected item's overflow-menu trigger (locale-neutral). */
export const missionMenuTrigger = (page: Page) => missionToolbar(page).locator(".action-overflow-trigger")

/** An action of the selected item's overflow menu (Interrupt now, the update request, Edit); opens the menu. */
export async function missionMenuAction(page: Page, label: string | RegExp): Promise<Locator> {
  await missionMenuTrigger(page).click()
  return page.getByRole("menuitem", { name: label, exact: typeof label === "string" })
}

/** An overflow-menu item by key (`interrupt`, `request`, `edit`), whatever its localized label; opens the menu. */
export async function missionMenuItem(page: Page, key: string): Promise<Locator> {
  const trigger = missionMenuTrigger(page)
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
  const item = page.locator(`[role=menuitem][data-action-key="${key}"]`)
  await item.waitFor()
  return item
}

/** An overflow-menu item's label and availability; the menu is closed again. */
export async function missionMenuItemState(page: Page, key: string): Promise<{ label: string; enabled: boolean }> {
  if (await missionMenuTrigger(page).isDisabled()) return { label: "", enabled: false }
  const item = await missionMenuItem(page, key)
  const state = { label: (await item.innerText()).trim(), enabled: await item.getAttribute("aria-disabled") !== "true" }
  await page.keyboard.press("Escape")
  await item.waitFor({ state: "detached" })
  return state
}

/** English labels of the overflow menu's actions; every other action is a toolbar button. */
const MENU_ACTIONS = new Set(["Interrupt now", "Request an update", "Edit selected mission"])

/** Click a selected-item toolbar or overflow-menu action, optionally selecting the item first. */
export async function clickMissionAction(page: Page, label: string, title?: string | RegExp): Promise<void> {
  if (title !== undefined) await selectMission(page, title)
  if (MENU_ACTIONS.has(label)) await (await missionMenuAction(page, label)).click()
  else await missionToolbarAction(page, label).click()
}

/** Select the item, then toggle its central overview reader with the Summary eye. */
export async function toggleMissionOverview(page: Page, title: string | RegExp): Promise<void> {
  await selectMission(page, title)
  await missionToolbar(page).locator(".mission-overview-toggle").click()
}
