import type { Locator, Page } from "playwright"

/** Select an event source through its own searchable picker, without changing another criterion. */
export async function selectMissionSource(page: Page, number: number, id: string): Promise<void> {
  await page.getByRole("button", { name: `Criterion ${number} source`, exact: true }).click()
  await page.getByRole("option").and(page.locator(`[data-source-id=${JSON.stringify(id)}]`)).click()
}

/** Open the shared creation/Preferences profile disclosure through its native summary. */
export async function openMissionProfiles(page: Page): Promise<void> {
  const fold = page.locator(".mission-profiles-disclosure")
  if (!await fold.evaluate((element: HTMLDetailsElement) => element.open)) await fold.locator("summary").click()
}

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

/** A row for a title: its chevron (`.session-item-expander`), flag and select button. */
export const missionRow = (page: Page, title: string | RegExp) =>
  missionRows(page).locator(".mission-row").filter({ has: titleFilter(page, title) })

/** Answer a red row like a session row: select it (again) to open its flag's question. */
export async function answerMissionRow(page: Page, title: string | RegExp): Promise<void> {
  const row = missionRow(page, title)
  await row.locator('.mission-row-flag[data-mark="permission"]').waitFor()
  await row.locator(".mission-row-select").click()
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
  // A refresh may retitle or replace the row after selection. Retain its identity, not its DOM node.
  const row = await stableMissionRow(entry), select = row.locator(".mission-row-select")
  if (await select.getAttribute("aria-current") !== "true") await select.click()
  // Like the session list, a click only selects: its chevron expands the row, showing its detail.
  // A Mission whose plan holds no task has no chevron: its (empty) detail stays folded.
  const leaf = await expandRowElement(row) === "leaf"
  const detail = missionDetail(page)
  await detail.waitFor({ state: leaf ? "attached" : "visible" })
  return detail
}

/** Expands the row of `select` (a row's select button) through its chevron, unless open;
 * "leaf" when the row has no chevron (a Mission without tasks). */
export async function expandRow(select: Locator): Promise<"expanded" | "leaf"> {
  await select.waitFor({ state: "attached" })
  return expandRowElement(await stableMissionRow(select))
}

async function stableMissionRow(select: Locator): Promise<Locator> {
  const key = await select.locator("xpath=ancestor::*[@data-mission-key][1]").getAttribute("data-mission-key")
  if (!key) throw new Error("Mission row identity unavailable")
  return missionRows(select.page()).locator(`.mission-row[data-mission-key=${JSON.stringify(key)}]`)
}

/** `expandRow` on an identity-bound row locator, including across passive replacement. */
async function expandRowElement(row: Locator): Promise<"expanded" | "leaf"> {
  await row.waitFor({ state: "visible" })
  const chevron = row.locator(".session-item-expander")
  await chevron.waitFor({ state: "attached" })
  if ((await chevron.getAttribute("class"))?.includes("session-item-expander--spacer")) return "leaf"
  if (await chevron.getAttribute("aria-expanded") !== "true") await chevron.click()
  await row.locator('.session-item-expander[aria-expanded="true"]').waitFor()
  return "expanded"
}

/** Shows the detail of a row selected without a click (restored or set through the view
 * state): expands it through its chevron and waits for the detail, attached for a leaf. */
export async function showSelection(page: Page): Promise<Locator> {
  const entry = missionRows(page).locator(".mission-row-select[aria-current=true]")
  await entry.waitFor({ timeout: 60_000 })
  const leaf = await expandRow(entry) === "leaf"
  const detail = missionDetail(page)
  await detail.waitFor({ state: leaf ? "attached" : "visible" })
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

/** A row's task button (`.mission-tree-task`) for a task title, wherever its tree is shown. */
export const missionTask = (scope: Page | Locator, title: string | RegExp) => {
  const page = "keyboard" in scope ? scope : scope.page()
  return scope.locator(".mission-tree-node").filter({ has: page.locator(".mission-tree-task .session-item-title", { hasText: exact(title) }) }).locator(".mission-tree-task")
}

/** Reveal a virtual task through its real scroll owner before native focus or clicks. */
export async function revealMissionTask(task: Locator): Promise<void> {
  const page = task.page(), panel = page.locator(".mission-control")
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (!await task.count()) await panel.evaluate(element => { element.scrollTop = 0 })
  const deadline = Date.now() + 10_000
  while (!await task.count() && Date.now() < deadline) {
    await panel.evaluate(element => { element.scrollTop += element.clientHeight * 0.75 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  await task.click({ trial: true })
}

/** Gives the toolbar back to the selected task's Mission (or schedule): selecting the row whose
 * tree holds it clears the task selection (an open reader follows to the Mission's overview).
 * No-op without a selected task. */
export async function selectTaskMission(page: Page): Promise<void> {
  const selected = ".mission-tree-task[aria-current=true]"
  if (!await missionRows(page).locator(selected).count()) return
  // The list item holding the selected task's tree; only a Mission/schedule item has a `.mission-row`.
  // Held as an element: the locator stops matching once the click clears the task selection.
  const entry = await missionRows(page).locator("li", { has: page.locator(selected) }).locator(".mission-row .mission-row-select").elementHandle()
  await entry!.click()
  await page.waitForFunction(element => element.getAttribute("aria-current") === "true", entry)
}

/** Select a task like a session row: one click, the only highlighted selection in the panel. */
export async function selectMissionTask(task: Locator): Promise<void> {
  if (await task.getAttribute("aria-current") !== "true") await task.click()
  await task.page().waitForFunction(element => element.getAttribute("aria-current") === "true", await task.elementHandle())
}

/** Open the selected task's reader: select the task, then press its toolbar's eye. */
export async function openTaskReader(task: Locator): Promise<void> {
  await selectMissionTask(task)
  const eye = missionToolbar(task.page()).locator(".mission-overview-toggle")
  if (await eye.getAttribute("aria-pressed") !== "true") await eye.click()
  await task.page().locator(".mission-reader").waitFor()
}

/** Serves the "ui" settings bucket in memory (GET/PATCH `/api/storage/config/ui`), seeded
 * with `settings`; register after any catch-all `/api` route so it takes precedence. */
export async function routeUiSettings(page: Page, settings: Record<string, unknown> = {}) {
  const state = { settings: { ...settings }, writes: [] as Array<Record<string, unknown>> }
  await page.route("**/api/storage/config/ui", route => {
    const request = route.request()
    if (request.method() !== "GET") {
      const body = request.postDataJSON() ?? {}, patch = (body.patch ?? body) as { settings?: Record<string, unknown> }
      state.writes.push(patch); state.settings = { ...state.settings, ...patch.settings }
    }
    return route.fulfill({ json: { settings: state.settings } })
  })
  return state
}

/** Waits until the app's loaded preferences hold `missionDeleteSessions === value`. */
export function waitForMissionDeleteSessions(page: Page, value: boolean): Promise<void> {
  return poll(() => page.evaluate(async () => {
    const path = "/src/stores/preferences.tsx"
    return (await import(path)).preferences().missionDeleteSessions as boolean
  }).then(current => current === value), `missionDeleteSessions ${value}`)
}

/** The Delegation depth row (`MissionSubagentDepth`): one labelled menu. */
export const depthMenu = (scope: Page | Locator) => scope.locator(".mission-depth select")

/** The lines the depth row's info tip reveals (hint, rule, effective depth, nesting, paths). */
export async function depthInfo(scope: Page | Locator): Promise<string[]> {
  const label = await scope.locator(".mission-depth .settings-info-tip").getAttribute("aria-label")
  return (label ?? "").replace(/[\u2066-\u2069]/g, "").split("\n")
}

async function poll(check: () => Promise<boolean>, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Waits until the depth info tip reveals `line`. */
export function waitForDepthInfo(scope: Page | Locator, line: string): Promise<void> {
  return poll(async () => (await depthInfo(scope)).includes(line), `depth info "${line}"`)
}

/** Waits until the depth menu takes a choice: enabled, and not locked by a read or write. */
export function waitForDepthReady(scope: Page | Locator): Promise<void> {
  return poll(() => depthMenu(scope).evaluate(menu => !(menu as HTMLSelectElement).disabled && !menu.hasAttribute("aria-disabled"), undefined, { timeout: 1_000 }),
    "an unlocked depth menu")
}
