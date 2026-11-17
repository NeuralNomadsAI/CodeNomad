import { createAnsiStreamRenderer, hasAnsi, type AnsiRenderOptions } from "../../lib/ansi"
import { escapeHtml } from "../../lib/text-render-utils"

export interface StableAnsiStreamUpdater {
  update: (element: HTMLElement, content: string, options?: AnsiRenderOptions) => void
  reset: () => void
}

export function createStableAnsiStreamUpdater(): StableAnsiStreamUpdater {
  const renderer = createAnsiStreamRenderer()
  let previousContent = ""
  let ansiActive = false
  let previousOptions: AnsiRenderOptions | undefined

  return {
    update(element: HTMLElement, content: string, options?: AnsiRenderOptions) {
      const resetStreaming = !previousContent || !content.startsWith(previousContent) || options !== previousOptions
      previousOptions = options

      if (resetStreaming) {
        ansiActive = hasAnsi(content)
        renderer.reset()
        element.innerHTML = ansiActive ? renderer.render(content, options) : escapeHtml(content)
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
        element.innerHTML = renderer.render(content, options)
        previousContent = content
        return
      }

      if (ansiActive) {
        const htmlChunk = renderer.render(delta, options)
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
      previousOptions = undefined
      renderer.reset()
    },
  }
}
