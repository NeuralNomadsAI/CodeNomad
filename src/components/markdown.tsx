import { createEffect, createSignal, Show } from "solid-js"
import { renderMarkdown } from "../lib/markdown"

interface MarkdownProps {
  content: string
  isDark?: boolean
}

export function Markdown(props: MarkdownProps) {
  const [html, setHtml] = createSignal("")
  let containerRef: HTMLDivElement | undefined

  createEffect(async () => {
    const rendered = await renderMarkdown(props.content)
    setHtml(rendered)
  })

  createEffect(() => {
    const currentHtml = html()
    if (containerRef && currentHtml) {
      setTimeout(() => {
        const codeBlocks = containerRef?.querySelectorAll(".markdown-code-block")

        codeBlocks?.forEach((block) => {
          const existing = block.querySelector(".code-block-header")
          if (existing) return

          const lang = block.getAttribute("data-language")
          const encodedCode = block.getAttribute("data-code")

          const header = document.createElement("div")
          header.className = "code-block-header"

          const languageSpan = lang
            ? `<span class="code-block-language">${lang}</span>`
            : '<span class="code-block-language"></span>'

          header.innerHTML = `
          ${languageSpan}
          <button class="code-block-copy" data-code="${encodedCode || ""}">
            <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="copy-text">Copy</span>
          </button>
        `
          block.insertBefore(header, block.firstChild)

          const button = header.querySelector(".code-block-copy")
          if (button) {
            button.addEventListener("click", async () => {
              const code = button.getAttribute("data-code")
              if (code) {
                const decodedCode = decodeURIComponent(code)
                await navigator.clipboard.writeText(decodedCode)
                const copyText = button.querySelector(".copy-text")
                if (copyText) {
                  copyText.textContent = "Copied!"
                  setTimeout(() => {
                    copyText.textContent = "Copy"
                  }, 2000)
                }
              }
            })
          }
        })
      }, 0)
    }
  })

  return <div ref={containerRef} class="prose prose-sm dark:prose-invert max-w-none" innerHTML={html()} />
}
