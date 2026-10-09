import type { Locator, Page } from "playwright"

/** Exercise the same action through its inline or measured-overflow presentation. */
export async function clickMissionAction(row: Locator, label: string): Promise<void> {
  const button = row.getByRole("button", { name: label, exact: true })
  if (await button.isVisible()) {
    await button.click()
    return
  }
  await row.getByRole("button", { name: "More actions", exact: true }).click()
  await row.page().getByRole("menuitem", { name: label, exact: true }).click()
}

/** The selected Mission's detail: a separate section below the list. */
export const missionDetail = (page: Page) => page.locator("section.mission-detail")

/** Select a list row (if not already selected) and wait for its detail section. */
export async function selectMissionRow(row: Locator): Promise<Locator> {
  const select = row.locator(".mission-index-select")
  await select.waitFor()
  if (await select.getAttribute("aria-current") !== "true") await select.click()
  const detail = missionDetail(row.page())
  await detail.waitFor()
  return detail
}

/** Select the row, then toggle its central overview reader with the Overview eye. */
export async function toggleMissionOverview(row: Locator): Promise<void> {
  const detail = await selectMissionRow(row)
  await detail.locator(".mission-overview-toggle").first().click()
}
