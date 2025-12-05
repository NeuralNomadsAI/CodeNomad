import { marked } from "marked"
import { createHighlighter, type Highlighter, bundledLanguages } from "shiki/bundle/full"
import { getLogger } from "./logger"

const log = getLogger("actions")

let highlighter: Highlighter | null = null
let highlighterPromise: Promise<Highlighter> | null = null
let currentTheme: "light" | "dark" = "light"
let isInitialized = false
let highlightSuppressed = false
let rendererSetup = false

const extensionToLanguage: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "bash",
  bash: "bash",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  rs: "rust",
  go: "go",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "cpp",
  c: "c",
  java: "java",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
}

export function getLanguageFromPath(path?: string | null): string | undefined {
  if (!path) return undefined
  const ext = path.split(".").pop()?.toLowerCase()
  return ext ? extensionToLanguage[ext] : undefined
}

// Track loaded languages and queue for on-demand loading
const loadedLanguages = new Set<string>()
const queuedLanguages = new Set<string>()
const languageLoadQueue: Array<() => Promise<void>> = []
let isQueueRunning = false

// Pub/sub mechanism for language loading notifications
const languageListeners: Array<() => void> = []

export function onLanguagesLoaded(callback: () => void): () => void {
  languageListeners.push(callback)

  // Return cleanup function
  return () => {
    const index = languageListeners.indexOf(callback)
    if (index > -1) {
      languageListeners.splice(index, 1)
    }
  }
}

function triggerLanguageListeners() {
  for (const listener of languageListeners) {
    try {
      listener()
    } catch (error) {
      log.error("Error in language listener", error)
    }
  }
}

async function getOrCreateHighlighter() {
  if (highlighter) {
    return highlighter
  }

  if (highlighterPromise) {
    return highlighterPromise
  }

  // Create highlighter with no preloaded languages
  highlighterPromise = createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
  })

  highlighter = await highlighterPromise
  highlighterPromise = null
  return highlighter
}

function normalizeLanguageToken(token: string): string {
  return token.trim().toLowerCase()
}

function resolveLanguage(token: string): { canonical: string | null; raw: string } {
  const normalized = normalizeLanguageToken(token)

  // Check if it's a direct key match
  if (normalized in bundledLanguages) {
    return { canonical: normalized, raw: normalized }
  }

  // Check aliases
  for (const [key, lang] of Object.entries(bundledLanguages)) {
    const aliases = (lang as { aliases?: string[] }).aliases
    if (aliases?.includes(normalized)) {
      return { canonical: key, raw: normalized }
    }
  }

  return { canonical: null, raw: normalized }
}

async function ensureLanguages(content: string) {
  if (highlightSuppressed) {
    return
  }
  // Parse code fences to extract language tokens
  // Updated regex to capture optional language tokens and handle trailing annotations
  const codeBlockRegex = /```[ \t]*([A-Za-z0-9_.+#-]+)?[^`]*?```/g
  const foundLanguages = new Set<string>()
  let match

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const langToken = match[1]
    if (langToken && langToken.trim()) {
      foundLanguages.add(langToken.trim())
    }
  }

  // Queue language loading tasks
  for (const token of foundLanguages) {
    const { canonical, raw } = resolveLanguage(token)
    const langKey = canonical || raw

    // Skip "text" and aliases since Shiki handles plain text already
    if (langKey === "text" || raw === "text") {
      continue
    }

    // Skip if already loaded or queued
    if (loadedLanguages.has(langKey) || queuedLanguages.has(langKey)) {
      continue
    }

    queuedLanguages.add(langKey)

    // Queue the language loading task
    languageLoadQueue.push(async () => {
      try {
        const h = await getOrCreateHighlighter()
        await h.loadLanguage(langKey as never)
        loadedLanguages.add(langKey)
        triggerLanguageListeners()
      } catch {
        // Quietly ignore errors
      } finally {
        queuedLanguages.delete(langKey)
      }
    })
  }

  // Trigger queue runner if not already running
  if (languageLoadQueue.length > 0 && !isQueueRunning) {
    runLanguageLoadQueue()
  }
}

export function decodeHtmlEntities(content: string): string {
  if (!content.includes("&")) {
    return content
  }

  const entityPattern = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  }

  let result = content
  let previous = ""

  while (result.includes("&") && result !== previous) {
    previous = result
    result = result.replace(entityPattern, (match, entity) => {
      if (!entity) {
        return match
      }

      if (entity[0] === "#") {
        const isHex = entity[1]?.toLowerCase() === "x"
        const value = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
        if (!Number.isNaN(value)) {
          try {
            return String.fromCodePoint(value)
          } catch {
            return match
          }
        }
        return match
      }

      const decoded = namedEntities[entity.toLowerCase()]
      return decoded !== undefined ? decoded : match
    })
  }

  return result
}

async function runLanguageLoadQueue() {
  if (isQueueRunning || languageLoadQueue.length === 0) {
    return
  }

  isQueueRunning = true

  while (languageLoadQueue.length > 0) {
    const task = languageLoadQueue.shift()
    if (task) {
      await task()
    }
  }

  isQueueRunning = false
}

function setupRenderer(isDark: boolean) {
  if (!highlighter || rendererSetup) return

  currentTheme = isDark ? "dark" : "light"

  marked.setOptions({
    breaks: true,
    gfm: true,
  })

  const renderer = new marked.Renderer()

  renderer.code = (code: string, lang: string | undefined) => {
    const decodedCode = decodeHtmlEntities(code)
    const encodedCode = encodeURIComponent(decodedCode)

    // Use "text" as default when no language is specified
    const resolvedLang = lang && lang.trim() ? lang.trim() : "text"
    const escapedLang = escapeHtml(resolvedLang)

    const header = `
<div class="code-block-header">
  <span class="code-block-language">${escapedLang}</span>
  <button class="code-block-copy" data-code="${encodedCode}">
    <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span class="copy-text">Copy</span>
  </button>
</div>
`.trim()

    if (highlightSuppressed) {
      return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${header}<pre><code class="language-${escapedLang}">${escapeHtml(decodedCode)}</code></pre></div>`
    }

    // Skip highlighting for "text" language or when highlighter is not available
    if (resolvedLang === "text" || !highlighter) {
      return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${header}<pre><code>${escapeHtml(decodedCode)}</code></pre></div>`
    }

    // Resolve language and check if it's loaded
    const { canonical, raw } = resolveLanguage(resolvedLang)
    const langKey = canonical || raw

    // Skip highlighting for "text" aliases
    if (langKey === "text" || raw === "text") {
      return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${header}<pre><code class="language-${escapedLang}">${escapeHtml(decodedCode)}</code></pre></div>`
    }

    // Use highlighting if language is loaded, otherwise fall back to plain code
    if (loadedLanguages.has(langKey)) {
      try {
        const html = highlighter!.codeToHtml(decodedCode, {
          lang: langKey,
          theme: currentTheme === "dark" ? "github-dark" : "github-light",
        })
        return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${header}${html}</div>`
      } catch {
        // Fall through to plain code if highlighting fails
      }
    }

    return `<div class="markdown-code-block" data-language="${escapedLang}" data-code="${encodedCode}">${header}<pre><code class="language-${escapedLang}">${escapeHtml(decodedCode)}</code></pre></div>`
  }

  renderer.link = (href: string, title: string | null | undefined, text: string) => {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`
  }

  renderer.codespan = (code: string) => {
    const decoded = decodeHtmlEntities(code)
    return `<code class="inline-code">${escapeHtml(decoded)}</code>`
  }

  marked.use({ renderer })
  rendererSetup = true
}

export async function initMarkdown(isDark: boolean) {
  await getOrCreateHighlighter()
  setupRenderer(isDark)
  isInitialized = true
}

export function isMarkdownReady(): boolean {
  return isInitialized && highlighter !== null
}

export async function renderMarkdown(
  content: string,
  options?: {
    suppressHighlight?: boolean
  },
): Promise<string> {
  if (!isInitialized) {
    await initMarkdown(currentTheme === "dark")
  }

  const suppressHighlight = options?.suppressHighlight ?? false
  const decoded = decodeHtmlEntities(content)

  if (!suppressHighlight) {
    // Queue language loading but don't wait for it to complete
    await ensureLanguages(decoded)
  }

  const previousSuppressed = highlightSuppressed
  highlightSuppressed = suppressHighlight

  try {
    // Proceed to parse immediately - highlighting will be available on next render
    return marked.parse(decoded) as Promise<string>
  } finally {
    highlightSuppressed = previousSuppressed
  }
}

export async function getSharedHighlighter(): Promise<Highlighter> {
  return getOrCreateHighlighter()
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    '"': "&quot;",
    "'": "&#039;",
  }
  return text.replace(/[&<"']/g, (m) => map[m])
}
