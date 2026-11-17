import { createAnsiStreamRenderer, hasAnsi } from "../../lib/ansi"
import { escapeHtml } from "../../lib/text-render-utils"

export interface StableAnsiStreamUpdater {
  update: (element: HTMLElement, content: string) => void
  reset: () => void
}

export function createStableAnsiStreamUpdater(): StableAnsiStreamUpdater {
  const renderer = createAnsiStreamRenderer()
  let previousContent = ""
  let ansiActive = false

  return {
    update(element: HTMLElement, content: string) {
      const resetStreaming = !previousContent || !content.startsWith(previousContent)

      if (resetStreaming) {
        ansiActive = hasAnsi(content)
        renderer.reset()
        element.innerHTML = ansiActive ? renderer.render(content) : escapeHtml(content)
        previousContent = content
        return
      }

      const delta = content.slice(previousContent.length)
      if (delta.length === 0) {
        return
      }

      if (!ansiActive && hasAnsi(delta)) {
        ansiActive = true
        renderer.reset()
        element.innerHTML = renderer.render(content)
        previousContent = content
        return
      }

      if (ansiActive) {
        const htmlChunk = renderer.render(delta)
        if (htmlChunk.length > 0) {
          element.insertAdjacentHTML("beforeend", htmlChunk)
        }
      } else {
        const escapedDelta = escapeHtml(delta)
        if (escapedDelta.length > 0) {
          element.insertAdjacentHTML("beforeend", escapedDelta)
        }
      }

      previousContent = content
    },
    reset() {
      previousContent = ""
      ansiActive = false
      renderer.reset()
    },
  }
}
