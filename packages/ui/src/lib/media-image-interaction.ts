export function blockMediaInteraction(event: Event) {
  event.preventDefault()
  event.stopPropagation()
}

const guardedImages = new WeakMap<HTMLImageElement, { wrapper: HTMLSpanElement; anchor: HTMLAnchorElement | null }>()
const guardedLinks = new WeakMap<HTMLAnchorElement, { href: string | null; count: number }>()

/** DOM-created Markdown images need the same hit-testing and link policy as JSX images. */
export function restrictMediaImage(image: HTMLImageElement, restricted: boolean) {
  const previous = guardedImages.get(image)
  if (previous && !restricted) {
    const link = previous.anchor && guardedLinks.get(previous.anchor)
    if (link && --link.count === 0) {
      if (link.href !== null) previous.anchor!.setAttribute("href", link.href)
      guardedLinks.delete(previous.anchor!)
    }
    image.style.removeProperty("pointer-events")
    if (!image.getAttribute("style")) image.removeAttribute("style")
    image.removeAttribute("draggable")
    previous.wrapper.replaceWith(image)
    guardedImages.delete(image)
  } else if (restricted && !previous) {
    const anchor = image.closest("a")
    if (anchor) {
      const link = guardedLinks.get(anchor) ?? { href: anchor.getAttribute("href"), count: 0 }
      link.count++
      guardedLinks.set(anchor, link)
      anchor.removeAttribute("href")
    }
    image.style.pointerEvents = "none"
    image.draggable = false
    const wrapper = document.createElement("span")
    wrapper.addEventListener("contextmenu", blockMediaInteraction)
    wrapper.addEventListener("auxclick", blockMediaInteraction)
    wrapper.addEventListener("click", blockMediaInteraction)
    image.replaceWith(wrapper)
    wrapper.append(image)
    guardedImages.set(image, { wrapper, anchor })
  }
}
