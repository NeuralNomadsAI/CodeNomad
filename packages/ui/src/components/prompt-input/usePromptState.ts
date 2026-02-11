import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"
import { addToHistory, getHistory } from "../../stores/message-history"
import { clearSessionDraftPrompt, getSessionDraftPrompt, setSessionDraftPrompt } from "../../stores/sessions"
import { getLogger } from "../../lib/logger"

const log = getLogger("actions")

type GetTextarea = () => HTMLTextAreaElement | undefined | null

type PromptStateOptions = {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>
  onSessionDraftLoaded?: (draft: string) => void
}

type HistorySelectOptions = {
  force?: boolean
  isPickerOpen: boolean
  getTextarea: GetTextarea
}

type PromptState = {
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  clearPrompt: () => void

  draftLoadedNonce: Accessor<number>

  history: Accessor<string[]>
  historyIndex: Accessor<number>
  historyDraft: Accessor<string | null>

  resetHistoryNavigation: () => void
  clearHistoryDraft: () => void
  recordHistoryEntry: (entry: string) => Promise<void>

  selectPreviousHistory: (options: HistorySelectOptions) => boolean
  selectNextHistory: (options: HistorySelectOptions) => boolean
}

const HISTORY_LIMIT = 100

export function usePromptState(options: PromptStateOptions): PromptState {
  const [prompt, setPromptInternal] = createSignal("")
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [historyDraft, setHistoryDraft] = createSignal<string | null>(null)
  const [draftLoadedNonce, setDraftLoadedNonce] = createSignal(0)

  const setPrompt = (value: string) => {
    setPromptInternal(value)
    // Persist drafts only when the user is at the "fresh" position (not browsing history).
    // This keeps the bottom-of-history draft stable even if the user edits recalled history entries.
    if (historyIndex() === -1) {
      setSessionDraftPrompt(options.instanceId(), options.sessionId(), value)
    }
  }

  const clearPrompt = () => {
    clearSessionDraftPrompt(options.instanceId(), options.sessionId())
    setPromptInternal("")
  }

  const resetHistoryNavigation = () => {
    setHistoryIndex(-1)
    setHistoryDraft(null)
  }

  const clearHistoryDraft = () => {
    setHistoryDraft(null)
  }

  createEffect(
    on(
      () => `${options.instanceId()}:${options.sessionId()}`,
      () => {
        const instanceId = options.instanceId()
        const sessionId = options.sessionId()

        onCleanup(() => {
          // Persist the previous session's draft when switching sessions.
          setSessionDraftPrompt(instanceId, sessionId, prompt())
        })

        const storedPrompt = getSessionDraftPrompt(instanceId, sessionId)

        setPromptInternal(storedPrompt)
        setSessionDraftPrompt(instanceId, sessionId, storedPrompt)

        resetHistoryNavigation()

        setDraftLoadedNonce((prev) => prev + 1)
        options.onSessionDraftLoaded?.(storedPrompt)
      },
    ),
  )

  onMount(() => {
    void (async () => {
      const loaded = await getHistory(options.instanceFolder())
      setHistory(loaded)
    })()
  })

  const recordHistoryEntry = async (entry: string) => {
    try {
      await addToHistory(options.instanceFolder(), entry)
      setHistory((prev) => {
        const next = [entry, ...prev]
        if (next.length > HISTORY_LIMIT) {
          next.length = HISTORY_LIMIT
        }
        return next
      })
      setHistoryIndex(-1)
    } catch (historyError) {
      log.error("Failed to update prompt history:", historyError)
    }
  }

  const canUseHistory = (selectOptions: HistorySelectOptions) => {
    if (selectOptions.force) return true
    if (selectOptions.isPickerOpen) return false

    const textarea = selectOptions.getTextarea()
    if (!textarea) return false

    // Only require the cursor to be at the buffer start when *entering* history navigation.
    // Once we're already navigating history (historyIndex >= 0), allow ArrowUp/ArrowDown
    // regardless of cursor position (we focus the end of the entry).
    if (historyIndex() !== -1) return true

    return textarea.selectionStart === 0 && textarea.selectionEnd === 0
  }

  const focusTextareaEnd = (getTextarea: GetTextarea) => {
    const textarea = getTextarea()
    if (!textarea) return
    setTimeout(() => {
      const next = getTextarea()
      if (!next) return
      const pos = next.value.length
      next.setSelectionRange(pos, pos)
      next.focus()
    }, 0)
  }

  const selectPreviousHistory = (selectOptions: HistorySelectOptions) => {
    const entries = history()
    if (entries.length === 0) return false
    if (!canUseHistory(selectOptions)) return false

    if (historyIndex() === -1) {
      setHistoryDraft(prompt())
    }

    const newIndex = historyIndex() === -1 ? 0 : Math.min(historyIndex() + 1, entries.length - 1)
    setHistoryIndex(newIndex)
    setPrompt(entries[newIndex])
    focusTextareaEnd(selectOptions.getTextarea)
    return true
  }

  const selectNextHistory = (selectOptions: HistorySelectOptions) => {
    const entries = history()
    if (entries.length === 0) return false
    if (!canUseHistory(selectOptions)) return false
    if (historyIndex() === -1) return false

    const newIndex = historyIndex() - 1
    if (newIndex >= 0) {
      setHistoryIndex(newIndex)
      setPrompt(entries[newIndex])
    } else {
      setHistoryIndex(-1)
      const draft = historyDraft() ?? getSessionDraftPrompt(options.instanceId(), options.sessionId())
      setPrompt(draft ?? "")
      setHistoryDraft(null)
    }
    focusTextareaEnd(selectOptions.getTextarea)
    return true
  }

  return {
    prompt,
    setPrompt,
    clearPrompt,

    draftLoadedNonce,

    history,
    historyIndex,
    historyDraft,

    resetHistoryNavigation,
    clearHistoryDraft,
    recordHistoryEntry,

    selectPreviousHistory,
    selectNextHistory,
  }
}
