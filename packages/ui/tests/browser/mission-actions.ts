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

/** The selected Mission's detail: a separate section below the picker. */
export const missionDetail = (page: Page) => page.locator("section.mission-detail")

/** The Mission picker: general toolbar (create, settings, refresh), chevron and current-mission field. */
export const missionPicker = (page: Page) => page.locator(".mission-control .mission-picker")
export const missionPickerField = (page: Page) => missionPicker(page).getByRole("combobox", { name: "Current mission", exact: true })
export const missionPickerExpander = (page: Page) => missionPicker(page).locator(".mission-picker-expander")
/** Title of the currently selected Mission/schedule shown in the picker field. */
export const selectedMissionTitle = (page: Page) => missionPickerField(page).locator(".mission-picker-title")

/** The general toolbar buttons above the current-mission line. */
export const missionGeneralAction = (page: Page, label: string) =>
  missionPicker(page).locator(".mission-picker-actions").getByRole("button", { name: label, exact: true })

/** The explicit panel refresh: read-only reconciliation, then resend of a still unconfirmed control. */
export const missionRefresh = (page: Page) => missionPicker(page).locator(".mission-picker-actions > button").last()

const exact = (title: string | RegExp) => typeof title === "string"
  ? new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) : title
const titleFilter = (page: Page, title: string | RegExp) => page.locator(".mission-picker-title", { hasText: exact(title) })

/** The transient popup's option for a title (the popup must be open). */
export const missionPopupOption = (page: Page, title: string | RegExp) =>
  missionPicker(page).locator(".mission-picker-popup [role=option]").filter({ has: titleFilter(page, title) })

/** Ensure the persistent inline list is expanded and return its row button for a title. */
export async function inlineMissionEntry(page: Page, title: string | RegExp): Promise<Locator> {
  const expander = missionPickerExpander(page)
  await expander.waitFor()
  if (await expander.getAttribute("aria-expanded") !== "true") await expander.click()
  return missionPicker(page).locator(".mission-picker-inline button.mission-picker-option").filter({ has: titleFilter(page, title) })
}

/** The entry's screen-reader status (state, attention, relative time / schedule), read from the inline list. */
export async function missionEntryStatus(page: Page, title: string | RegExp): Promise<string> {
  const entry = await inlineMissionEntry(page, title)
  return (await entry.locator(".sr-only").textContent()) ?? ""
}

/** Select a Mission/schedule by title through the transient popup and wait for its detail. */
export async function selectMission(page: Page, title: string | RegExp): Promise<Locator> {
  const field = missionPickerField(page)
  // Often the first wait after navigation: allow for a cold page boot late in a long serial run.
  await field.waitFor({ timeout: 60_000 })
  const current = await field.locator(".mission-picker-title").count()
    ? await field.locator(".mission-picker-title").innerText() : undefined
  const matches = current !== undefined && (typeof title === "string" ? current === title : title.test(current))
  if (!matches) {
    if (await field.getAttribute("aria-expanded") !== "true") await field.click()
    await missionPopupOption(page, title).click()
  }
  const detail = missionDetail(page)
  await detail.waitFor()
  return detail
}

/** A button of the selected item's icon toolbar (Play/Pause, Stop, Run now, Summary, Open conversation, Edit, Delete). */
export const missionToolbarAction = (page: Page, label: string) =>
  missionDetail(page).locator(".mission-action-bar").getByRole("button", { name: label, exact: true })

/** Click a selected-item toolbar action, optionally selecting the item first. */
export async function clickMissionAction(page: Page, label: string, title?: string | RegExp): Promise<void> {
  if (title !== undefined) await selectMission(page, title)
  await missionToolbarAction(page, label).click()
}

/** Select the item, then toggle its central overview reader with the Summary eye. */
export async function toggleMissionOverview(page: Page, title: string | RegExp): Promise<void> {
  const detail = await selectMission(page, title)
  await detail.locator(".mission-overview-toggle").first().click()
}
