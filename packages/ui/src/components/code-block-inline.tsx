import { createSignal, onMount, Show, createEffect } from "solid-js"
import type { Highlighter } from "shiki/bundle/full"
import { useTheme } from "../lib/theme"
import { getSharedHighlighter, escapeHtml } from "../lib/markdown"
import { copyToClipboard } from "../lib/clipboard"

const inlineLoadedLanguages = new Set<string>()

type LoadLanguageArg = Parameters<Highlighter["loadLanguage"]>[0]
type CodeToHtmlOptions = Parameters<Highlighter["codeToHtml"]>[1]

interface CodeBlockInlineProps {
  code: string
  language?: string
}

export function CodeBlockInline(props: CodeBlockInlineProps) {
  const { isDark } = useTheme()
  const [html, setHtml] = createSignal("")
  const [copied, setCopied] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  let highlighter: Highlighter | null = null

  onMount(async () => {
    highlighter = await getSharedHighlighter()
    setReady(true)
    await updateHighlight()
  })

  createEffect(() => {
    if (ready()) {
      isDark()
      props.code
      props.language
      void updateHighlight()
    }
  })

  const updateHighlight = async () => {
    if (!highlighter) return

    if (!props.language) {
      setHtml(`<pre><code>${escapeHtml(props.code)}</code></pre>`)
      return
    }

    try {
      const language = props.language as LoadLanguageArg
      if (!inlineLoadedLanguages.has(props.language)) {
        await highlighter.loadLanguage(language)
        inlineLoadedLanguages.add(props.language)
      }

      const highlighted = highlighter.codeToHtml(props.code, {
        lang: props.language as CodeToHtmlOptions["lang"],
        theme: isDark() ? "github-dark" : "github-light",
      })
      setHtml(highlighted)
    } catch {
      setHtml(`<pre><code>${escapeHtml(props.code)}</code></pre>`)
    }
  }

  const copyCode = async () => {
    const success = await copyToClipboard(props.code)
    if (success) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show
      when={ready()}
      fallback={
        <pre class="tool-call-content">
          <code>{props.code}</code>
        </pre>
      }
    >
      <div class="code-block-inline">
        <div class="code-block-header">
          <Show when={props.language}>
            <span class="code-block-language">{props.language}</span>
          </Show>
          <button onClick={copyCode} class="code-block-copy">
            <svg
              class="copy-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="copy-text">
              <Show when={copied()} fallback="Copy">
                Copied!
              </Show>
            </span>
          </button>
        </div>
        <div innerHTML={html()} />
      </div>
    </Show>
  )
}
