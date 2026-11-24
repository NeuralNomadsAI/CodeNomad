import { createMemo, type Accessor, type JSX } from "solid-js"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"

/** JSX nodes have one DOM owner. Only passive SVG artwork may be mirrored into
 * the menu: never duplicate arbitrary components, interactive HTML or listeners. */
function menuArtwork(icon: JSX.Element): JSX.Element {
  if (!(icon instanceof SVGElement) || icon.localName !== "svg") return undefined
  const passive = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "title", "desc"])
  const elements = [icon, ...icon.querySelectorAll("*")]
  if (elements.some(element => !passive.has(element.localName)
    || [...element.attributes].some(attribute => attribute.name === "tabindex" || attribute.name.startsWith("on")))) return undefined
  const copy = icon.cloneNode(true) as SVGElement
  for (const element of [copy, ...copy.querySelectorAll("*")]) element.removeAttribute("id")
  copy.setAttribute("aria-hidden", "true")
  copy.setAttribute("focusable", "false")
  copy.style.pointerEvents = "none"
  return copy
}

/** Stable keyed descriptors let both For surfaces retain controls on refresh.
 * Getters and event wrappers always resolve the latest descriptor, including
 * the menu's deferred selection after its close/autofocus sequence. */
export function createMissionListActions(read: Accessor<ActionOverflowMenuItem[] | undefined>) {
  const latest = createMemo(() => new Map((read() ?? []).map(item => [item.key, item])))
  const entries = new Map<string, { inline: ActionOverflowMenuItem; menu: ActionOverflowMenuItem }>()
  const ordered = createMemo(() => {
    const current = latest()
    for (const key of entries.keys()) if (!current.has(key)) entries.delete(key)
    return [...current.keys()].map(key => {
      let entry = entries.get(key)
      if (!entry) {
        const item = () => latest().get(key)
        const inline: ActionOverflowMenuItem = {
          key,
          get label() { return item()?.label ?? "" },
          get description() { return item()?.description },
          get icon() { return item()?.icon },
          get disabled() { return !item() || item()!.disabled },
          get checked() { return item()?.checked },
          onSelect: () => item()?.onSelect(),
          onMouseEnter: () => item()?.onMouseEnter?.(),
          onMouseLeave: () => item()?.onMouseLeave?.(),
        }
        let previousIcon: JSX.Element, artwork: JSX.Element
        const menu = Object.create(inline) as ActionOverflowMenuItem
        Object.defineProperty(menu, "icon", { get() {
          const icon = item()?.icon
          if (icon !== previousIcon) { previousIcon = icon; artwork = menuArtwork(icon) }
          return artwork
        } })
        entry = { inline, menu }
        entries.set(key, entry)
      }
      return entry
    })
  })
  return { inline: () => ordered().map(entry => entry.inline), menu: () => ordered().map(entry => entry.menu) }
}
