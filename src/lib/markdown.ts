import { marked } from "marked"
import { getHighlighter, type Highlighter } from "shiki"

let highlighter: Highlighter | null = null
let highlighterPromise: Promise<Highlighter> | null = null
let currentTheme: "light" | "dark" = "light"
let isInitialized = false

async function getOrCreateHighlighter() {
  if (highlighter) {
    return highlighter
  }

  if (highlighterPromise) {
    return highlighterPromise
  }

  highlighterPromise = getHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
  })

  highlighter = await highlighterPromise
  highlighterPromise = null
  return highlighter
}

function setupRenderer(isDark: boolean) {
  if (!highlighter) return

  currentTheme = isDark ? "dark" : "light"

  marked.setOptions({
    breaks: true,
    gfm: true,
  })

  const renderer = new marked.Renderer()

  renderer.code = (code: string, lang: string | undefined) => {
    const encodedCode = encodeURIComponent(code)
    const escapedLang = lang ? escapeHtml(lang) : ""

    if (!lang || !highlighter) {
      return `<div class="markdown-code-block" data-language="" data-code="${encodedCode}"><pre><code>${escapeHtml(code)}</code></pre></div>`
    }

    try {
      const html = highlighter.codeToHtml(code, {
        lang,
        theme: isDark ? "github-dark" : "github-light",
      })
      return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${html}</div>`
    } catch {
      return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}"><pre><code class="language-${escapedLang}">${escapeHtml(code)}</code></pre></div>`
    }
  }

  renderer.link = (href: string, title: string | null | undefined, text: string) => {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`
  }

  renderer.codespan = (code: string) => {
    return `<code class="inline-code">${escapeHtml(code)}</code>`
  }

  marked.use({ renderer })
}

export async function initMarkdown(isDark: boolean) {
  await getOrCreateHighlighter()
  setupRenderer(isDark)
  isInitialized = true
}

export function isMarkdownReady(): boolean {
  return isInitialized && highlighter !== null
}

export async function renderMarkdown(content: string): Promise<string> {
  if (!isInitialized) {
    await initMarkdown(currentTheme === "dark")
  }
  return marked.parse(content) as Promise<string>
}

export async function getSharedHighlighter(): Promise<Highlighter> {
  return getOrCreateHighlighter()
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}
