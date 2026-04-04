import { marked } from "marked"
import { getLogger } from "./logger"
import { tGlobal } from "./i18n"
import type { Highlighter } from "shiki/bundle/full"
import { decodeHtmlEntities, escapeHtml } from "./text-render-utils"

const log = getLogger("actions")

let highlighter: Highlighter | null = null
let highlighterPromise: Promise<Highlighter> | null = null
let currentTheme: "light" | "dark" = "light"
let isInitialized = false
let highlightSuppressed = false
let escapeRawHtmlEnabled = false
let rendererSetup = false
let shikiModulePromise: Promise<typeof import("shiki/bundle/full")> | null = null
let bundledLanguagesCache: typeof import("shiki/bundle/full")["bundledLanguages"] | null = null

// Track loaded languages and queue for on-demand loading
const loadedLanguages = new Set<string>()
const queuedLanguages = new Set<string>()
const languageLoadQueue: Array<() => Promise<void>> = []
let isQueueRunning = false

// Cache for ensureLanguages to avoid redundant marked.lexer() calls
let lastEnsuredContent = ""

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

  highlighterPromise = (async () => {
    const shiki = await loadShikiModule()
    return shiki.createHighlighter({
      themes: ["github-light", "github-light-high-contrast", "github-dark"],
      langs: [],
    })
  })().catch((error) => {
    highlighterPromise = null
    throw error
  })

  highlighter = await highlighterPromise
  highlighterPromise = null
  return highlighter
}

async function loadShikiModule() {
  if (!shikiModulePromise) {
    shikiModulePromise = import("shiki/bundle/full").then((module) => {
      bundledLanguagesCache = module.bundledLanguages
      return module
    })
  }

  return shikiModulePromise
}

function queueHighlighterWarmup() {
  if (highlighter || highlighterPromise) {
    return
  }

  void getOrCreateHighlighter().catch((error) => {
    log.warn("Failed to initialize markdown highlighter", error)
  })
}

function normalizeLanguageToken(token: string): string {
  return token.trim().toLowerCase()
}

function resolveLanguage(token: string): { canonical: string | null; raw: string } {
  const normalized = normalizeLanguageToken(token)
  const bundledLanguages = bundledLanguagesCache
  if (!bundledLanguages) {
    return { canonical: null, raw: normalized }
  }

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

function collectCodeFenceLanguages(content: string): string[] {
  const foundLanguages = new Set<string>()
  try {
    const tokens = marked.lexer(content) as any
    marked.walkTokens(tokens, (token: any) => {
      if (token?.type !== "code") return
      const langToken = typeof token.lang === "string" ? token.lang : ""
      if (langToken.trim()) {
        foundLanguages.add(langToken.trim())
      }
    })
  } catch {
    return []
  }

  return [...foundLanguages]
}

export function hasPendingCodeHighlight(content: string): boolean {
  const languages = collectCodeFenceLanguages(content)
  for (const token of languages) {
    const rawToken = normalizeLanguageToken(token)
    if (!rawToken || rawToken === "text") {
      continue
    }

    const { canonical, raw } = resolveLanguage(token)
    const langKey = canonical || raw
    if (langKey === "text" || raw === "text") {
      continue
    }

    if (!highlighter || !loadedLanguages.has(langKey)) {
      return true
    }
  }

  return false
}

async function ensureLanguages(content: string) {
  if (highlightSuppressed) {
    return
  }

  if (content === lastEnsuredContent) {
    return
  }

  if (
    lastEnsuredContent.length > 0 &&
    content.length > lastEnsuredContent.length &&
    content.startsWith(lastEnsuredContent)
  ) {
    const newPortion = content.slice(lastEnsuredContent.length)
    if (!newPortion.includes("```")) {
      lastEnsuredContent = content
      return
    }
  }

  lastEnsuredContent = content

  // Extract code-fence language tokens via `marked` so we correctly handle code blocks
  // that contain backticks (e.g. JS template literals). Regex-based fence scans tend
  // to miss these and prevent languages from loading.
  const foundLanguages = collectCodeFenceLanguages(content)

  // Queue language loading tasks
  for (const token of foundLanguages) {
    const rawToken = normalizeLanguageToken(token)
    if (!rawToken) {
      continue
    }

    // Skip "text" and aliases since Shiki handles plain text already
    if (rawToken === "text") {
      continue
    }

    // Skip if already loaded or queued
    if (loadedLanguages.has(rawToken) || queuedLanguages.has(rawToken)) {
      continue
    }

    queuedLanguages.add(rawToken)

    // Queue the language loading task
    languageLoadQueue.push(async () => {
      try {
        await loadShikiModule()
        const { canonical, raw } = resolveLanguage(token)
        const langKey = canonical || raw

        if (langKey === "text" || raw === "text") {
          return
        }

        const h = await getOrCreateHighlighter()
        await h.loadLanguage(langKey as never)
        loadedLanguages.add(langKey)
        loadedLanguages.add(raw)
        triggerLanguageListeners()
      } catch {
        // Quietly ignore errors
      } finally {
        queuedLanguages.delete(rawToken)
      }
    })
  }

  // Trigger queue runner if not already running
  if (languageLoadQueue.length > 0 && !isQueueRunning) {
    runLanguageLoadQueue()
  }
}

async function runLanguageLoadQueue() {
  if (isQueueRunning || languageLoadQueue.length === 0) {
    return
  }

  isQueueRunning = true

  while (languageLoadQueue.length > 0) {
    // Drain the current queue and run all pending loads concurrently.
    // New languages queued while this batch runs will be picked up by
    // the outer while-loop on the next iteration.
    const batch = languageLoadQueue.splice(0)
    await Promise.allSettled(batch.map((task) => task()))
  }

  isQueueRunning = false
}

function setupRenderer(isDark: boolean) {
  currentTheme = isDark ? "dark" : "light"
  if (rendererSetup) return

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
    const copyLabel = escapeHtml(tGlobal("markdown.copy"))

    const header = `
 <div class="code-block-header">
   <span class="code-block-language">${escapedLang}</span>
   <button class="code-block-copy" data-code="${encodedCode}">
    <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
     </svg>
    <span class="copy-text">${copyLabel}</span>
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
           theme: currentTheme === "dark" ? "github-dark" : "github-light-high-contrast",
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

  renderer.html = (html: string) => {
    if (!escapeRawHtmlEnabled) {
      return html
    }

    return escapeHtml(decodeHtmlEntities(html))
  }

  marked.use({ renderer })
  rendererSetup = true
}

export async function initMarkdown(isDark: boolean) {
  setupRenderer(isDark)
  queueHighlighterWarmup()
  await getOrCreateHighlighter()
  isInitialized = true
}

export function setMarkdownTheme(isDark: boolean) {
  currentTheme = isDark ? "dark" : "light"
}

export function isMarkdownReady(): boolean {
  return isInitialized && highlighter !== null
}

export async function renderMarkdown(
  content: string,
  options?: {
    suppressHighlight?: boolean
    escapeRawHtml?: boolean
  },
): Promise<string> {
  if (!isInitialized) {
    setupRenderer(currentTheme === "dark")
    isInitialized = true
  }

  const suppressHighlight = options?.suppressHighlight ?? false
  const escapeRawHtml = options?.escapeRawHtml ?? false
  const decoded = decodeHtmlEntities(content)

  if (!suppressHighlight) {
    queueHighlighterWarmup()
    void ensureLanguages(decoded)
  }

  const previousSuppressed = highlightSuppressed
  const previousEscapeRawHtml = escapeRawHtmlEnabled
  highlightSuppressed = suppressHighlight
  escapeRawHtmlEnabled = escapeRawHtml

  try {
    // Proceed to parse immediately - highlighting will be available on next render
    return marked.parse(decoded) as Promise<string>
  } finally {
    highlightSuppressed = previousSuppressed
    escapeRawHtmlEnabled = previousEscapeRawHtml
  }
}

export async function getSharedHighlighter(): Promise<Highlighter> {
  return getOrCreateHighlighter()
}
