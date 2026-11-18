import { createEffect, createSignal } from "solid-js"
import { claimSettingsRow, settingsRowTarget, type SettingsRowId } from "../../stores/settings-screen"

/** A settings row whose stable `id` another surface links to (`openSettingsRow`): once
 * targeted, it takes focus and stays in view until its own first read settles, while
 * the cards above it load. Give the row `tabindex="-1"`. */
export function useSettingsRowTarget(row: SettingsRowId, element: () => HTMLElement | undefined, settled: () => boolean) {
  const [revealing, setRevealing] = createSignal(false)
  createEffect(() => {
    const target = element()
    if (settingsRowTarget() !== row || !target || !claimSettingsRow(row)) return
    target.focus({ preventScroll: true }); target.scrollIntoView({ block: "nearest" })
    setRevealing(true)
    requestAnimationFrame(() => element()?.scrollIntoView({ block: "nearest" }))
  })
  createEffect(() => {
    if (!revealing() || !settled()) return
    requestAnimationFrame(() => element()?.scrollIntoView({ block: "nearest" }))
    setRevealing(false)
  })
}
