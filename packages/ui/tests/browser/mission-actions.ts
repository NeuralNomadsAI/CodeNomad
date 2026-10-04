import type { Locator } from "playwright"

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
