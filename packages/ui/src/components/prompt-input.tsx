import { createSignal, Show, onMount, onCleanup, createEffect, on, untrack } from "solid-js"
import { ArrowBigUp, ArrowBigDown } from "lucide-solid"
import UnifiedPicker from "./unified-picker"
import ExpandButton from "./expand-button"
import { getAttachments, clearAttachments, removeAttachment } from "../stores/attachments"
import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import Kbd from "./kbd"
import { getActiveInstance } from "../stores/instances"
import { agents, executeCustomCommand } from "../stores/sessions"
import { getCommands } from "../stores/commands"
import { showAlertDialog } from "../stores/alerts"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { preferences } from "../stores/preferences"
import type { ExpandState, PromptInputApi, PromptInputProps, PromptInsertMode, PromptMode } from "./prompt-input/types"
import { usePromptState } from "./prompt-input/usePromptState"
import { usePromptAttachments } from "./prompt-input/usePromptAttachments"
import { usePromptPicker } from "./prompt-input/usePromptPicker"
import { usePromptKeyDown } from "./prompt-input/usePromptKeyDown"
const log = getLogger("actions")

export default function PromptInput(props: PromptInputProps) {
  const { t } = useI18n()
  const [, setIsFocused] = createSignal(false)
  const [mode, setMode] = createSignal<PromptMode>("normal")
  const [expandState, setExpandState] = createSignal<ExpandState>("normal")
  const SELECTION_INSERT_MAX_LENGTH = 2000
  let textareaRef: HTMLTextAreaElement | undefined

  const getPlaceholder = () => {
    if (mode() === "shell") {
      return t("promptInput.placeholder.shell")
    }
    return t("promptInput.placeholder.default")
  }

  const promptState = usePromptState({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
  })

  const {
    prompt,
    setPrompt,
    clearPrompt,
    draftLoadedNonce,
    history,
    historyIndex,
    recordHistoryEntry,
    clearHistoryDraft,
    resetHistoryNavigation,
    selectPreviousHistory,
    selectNextHistory,
  } = promptState

  const {
    attachments,
    isDragging,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    syncAttachmentCounters,
    handleExpandTextAttachment,
  } = usePromptAttachments({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
  })

  createEffect(() => {
    if (!props.registerPromptInputApi) return
    const api: PromptInputApi = {
      insertSelection: (text: string, mode: PromptInsertMode) => {
        if (mode === "code") {
          insertCodeSelection(text)
        } else {
          insertQuotedSelection(text)
        }
      },
      expandTextAttachment: (attachmentId: string) => {
        const attachment = attachments().find((a) => a.id === attachmentId)
        if (!attachment) return
        handleExpandTextAttachment(attachment)
      },
      setPromptText: (text: string, opts?: { focus?: boolean }) => {
        const textarea = textareaRef
        if (textarea) {
          textarea.value = text
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          if (opts?.focus) {
            try {
              textarea.focus({ preventScroll: true } as any)
            } catch {
              textarea.focus()
            }
          }
          return
        }

        setPrompt(text)
        if (opts?.focus) {
          setTimeout(() => {
            api.focus()
          }, 0)
        }
      },
      focus: () => {
        const textarea = textareaRef
        if (!textarea || textarea.disabled) return
        try {
          textarea.focus({ preventScroll: true } as any)
        } catch {
          textarea.focus()
        }
      },
    }
    const cleanup = props.registerPromptInputApi(api)
    onCleanup(() => {
      if (typeof cleanup === "function") {
        cleanup()
      }
    })
  })

  const instanceAgents = () => agents().get(props.instanceId) || []

  const promptPicker = usePromptPicker({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    instanceAgents,
    commands: () => getCommands(props.instanceId),
  })

  const {
    showPicker,
    pickerMode,
    searchQuery,
    ignoredAtPositions,
    setShowPicker,
    setPickerMode,
    setSearchQuery,
    setAtPosition,
    setIgnoredAtPositions,
    handleInput,
    handlePickerSelect,
    handlePickerClose,
  } = promptPicker

  createEffect(
    on(
      draftLoadedNonce,
      () => {
        // Session switch resets (picker/counters/ignored positions) stay in the component.
        setIgnoredAtPositions(new Set<number>())
        setShowPicker(false)
        setPickerMode("mention")
        setAtPosition(null)
        setSearchQuery("")

        const instanceId = props.instanceId
        const sessionId = props.sessionId
        const currentAttachments = untrack(() => getAttachments(instanceId, sessionId))
        syncAttachmentCounters(prompt(), currentAttachments)
      },
      { defer: true },
    ),
  )

  onMount(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement

      const isInputElement =
        activeElement?.tagName === "INPUT" ||
        activeElement?.tagName === "TEXTAREA" ||
        activeElement?.tagName === "SELECT" ||
        activeElement?.isContentEditable

      if (isInputElement) return

      const isModifierKey = e.ctrlKey || e.metaKey || e.altKey
      if (isModifierKey) return

      const isSpecialKey =
        e.key === "Tab" || e.key === "Enter" || e.key.startsWith("Arrow") || e.key === "Backspace" || e.key === "Delete"
      if (isSpecialKey) return

      if (e.key.length === 1 && textareaRef && !props.disabled) {
        textareaRef.focus()
      }
    }

    document.addEventListener("keydown", handleGlobalKeyDown)

    onCleanup(() => {
      document.removeEventListener("keydown", handleGlobalKeyDown)
    })
  })

  async function handleSend() {
    const text = prompt().trim()
    const currentAttachments = attachments()
    if (props.disabled || (!text && currentAttachments.length === 0)) return

    const isShellMode = mode() === "shell"

    // Slash command routing (match OpenCode TUI): only run if the command exists.
    const isSlashCandidate = !isShellMode && text.startsWith("/")
    const firstSpace = isSlashCandidate ? text.indexOf(" ") : -1
    const commandToken = isSlashCandidate ? (firstSpace === -1 ? text : text.slice(0, firstSpace)) : ""
    const commandName = isSlashCandidate ? commandToken.slice(1) : ""
    const commandArgs = isSlashCandidate ? (firstSpace === -1 ? "" : text.slice(firstSpace + 1).trimStart()) : ""

    const isKnownSlashCommand =
      isSlashCandidate &&
      commandName.length > 0 &&
      getCommands(props.instanceId).some((cmd) => cmd.name === commandName)

    const resolvedPrompt = isKnownSlashCommand ? text : resolvePastedPlaceholders(text, currentAttachments)
    const historyEntry = resolvedPrompt

    const refreshHistory = () => recordHistoryEntry(historyEntry)

    setExpandState("normal")
    clearPrompt()
    clearHistoryDraft()
    setMode("normal")

    // Ignore attachments for slash commands, but keep them for next prompt.
    if (!isKnownSlashCommand) {
      clearAttachments(props.instanceId, props.sessionId)
      syncAttachmentCounters("", [])
      setIgnoredAtPositions(new Set<number>())
    } else {
      syncAttachmentCounters("", currentAttachments)
      setIgnoredAtPositions(new Set<number>())
    }

    clearHistoryDraft()

    if (isKnownSlashCommand) {
      // Record attempted slash commands even if execution fails.
      void refreshHistory()
    }

    try {
      if (isShellMode) {
        if (props.onRunShell) {
          await props.onRunShell(resolvedPrompt)
        } else {
          await props.onSend(resolvedPrompt, [])
        }
      } else if (isKnownSlashCommand) {
        await executeCustomCommand(props.instanceId, props.sessionId, commandName, commandArgs)
      } else {
        await props.onSend(resolvedPrompt, currentAttachments)
      }
      if (!isKnownSlashCommand) {
        void refreshHistory()
      }
    } catch (error) {
      log.error("Failed to send message:", error)
      showAlertDialog(t("promptInput.send.errorFallback"), {
        title: t("promptInput.send.errorTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      textareaRef?.focus()
    }
  }

  function handleAbort() {
    if (!props.onAbortSession || !props.isSessionBusy) return
    void props.onAbortSession()
  }

  function handleExpandToggle(nextState: "normal" | "expanded") {
    setExpandState(nextState)
    // Keep focus on textarea
    textareaRef?.focus()
  }

  function insertBlockContent(block: string) {
    const textarea = textareaRef
    const current = prompt()
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    const before = current.substring(0, start)
    const after = current.substring(end)
    const needsLeading = before.length > 0 && !before.endsWith("\n") ? "\n" : ""
    const insertion = `${needsLeading}${block}`
    const nextValue = before + insertion + after

    setPrompt(nextValue)
    setShowPicker(false)
    setAtPosition(null)

    if (textarea) {
      setTimeout(() => {
        const cursor = before.length + insertion.length
        textarea.focus()
        textarea.setSelectionRange(cursor, cursor)
      }, 0)
    }
  }

  function insertQuotedSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "").trim()
    if (!normalized) return
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH).trimEnd()
        : normalized
    const lines = limited
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) return

    const blockquote = lines.map((line) => `> ${line}`).join("\n")
    if (!blockquote) return

    insertBlockContent(`${blockquote}\n`)
  }

  function insertCodeSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "")
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH)
        : normalized
    const trimmed = limited.replace(/^\n+/, "").replace(/\n+$/, "")
    if (!trimmed) return

    const block = "```\n" + trimmed + "\n```\n\n"
    insertBlockContent(block)
  }

  const canStop = () => Boolean(props.isSessionBusy && props.onAbortSession)

  const hasHistory = () => history().length > 0
  const canHistoryGoPrevious = () => hasHistory() && (historyIndex() === -1 || historyIndex() < history().length - 1)
  const canHistoryGoNext = () => historyIndex() >= 0

  const canSend = () => {
    if (props.disabled) return false
    const hasText = prompt().trim().length > 0
    if (mode() === "shell") return hasText
    return hasText || attachments().length > 0
  }

  const shellHint = () =>
    mode() === "shell"
      ? { key: "Esc", text: t("promptInput.hints.shell.exit") }
      : { key: "!", text: t("promptInput.hints.shell.enable") }
  const commandHint = () => ({ key: "/", text: t("promptInput.hints.commands") })

  const submitOnEnter = () => preferences().promptSubmitOnEnter

  const handleKeyDown = usePromptKeyDown({
    getTextarea: () => textareaRef ?? null,
    prompt,
    setPrompt,
    mode,
    setMode,
    isPickerOpen: showPicker,
    closePicker: handlePickerClose,
    ignoredAtPositions,
    setIgnoredAtPositions,
    getAttachments: attachments,
    removeAttachment: (attachmentId) => removeAttachment(props.instanceId, props.sessionId, attachmentId),
    submitOnEnter,
    onSend: () => void handleSend(),
    selectPreviousHistory: (force) =>
      selectPreviousHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
    selectNextHistory: (force) =>
      selectNextHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
  })

  const shouldShowOverlay = () => prompt().length === 0

  const instance = () => getActiveInstance()

  return (
    <div class="prompt-input-container">
      <div
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2" : ""}`}
        style={
          isDragging()
            ? "border-color: var(--accent-primary); background-color: rgba(0, 102, 255, 0.05);"
            : ""
        }
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Show when={showPicker() && instance()}>
          <UnifiedPicker
            open={showPicker()}
            mode={pickerMode()}
            onClose={handlePickerClose}
            onSelect={handlePickerSelect}
            agents={instanceAgents()}
            commands={getCommands(props.instanceId)}
            instanceClient={instance()!.client}
            searchQuery={searchQuery()}
            textareaRef={textareaRef}
            workspaceId={props.instanceId}
          />
        </Show>

        <div class="flex flex-1 flex-col">
          <div class={`prompt-input-field-container ${expandState() === "expanded" ? "is-expanded" : ""}`}>

            <div class={`prompt-input-field ${expandState() === "expanded" ? "is-expanded" : ""}`}>
              <textarea
                ref={textareaRef}
                class={`prompt-input ${mode() === "shell" ? "shell-mode" : ""} ${expandState() === "expanded" ? "is-expanded" : ""}`}
                placeholder={getPlaceholder()}
                value={prompt()}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={props.disabled}
                rows={expandState() === "expanded" ? 15 : 4}
                spellcheck={false}
                autocorrect="off"
                autoCapitalize="off"
                autocomplete="off"
              />
              <div class="prompt-nav-buttons">
                <ExpandButton
                  expandState={expandState}
                  onToggleExpand={handleExpandToggle}
                />
                <Show when={hasHistory()}>
                  <button
                    type="button"
                    class="prompt-history-button"
                    onClick={() =>
                      selectPreviousHistory({
                        force: true,
                        isPickerOpen: showPicker(),
                        getTextarea: () => textareaRef,
                      })
                    }
                    disabled={!canHistoryGoPrevious()}
                    aria-label={t("promptInput.history.previousAriaLabel")}
                  >
                    <ArrowBigUp class="h-5 w-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="prompt-history-button"
                    onClick={() =>
                      selectNextHistory({
                        force: true,
                        isPickerOpen: showPicker(),
                        getTextarea: () => textareaRef,
                      })
                    }
                    disabled={!canHistoryGoNext()}
                    aria-label={t("promptInput.history.nextAriaLabel")}
                  >
                    <ArrowBigDown class="h-5 w-5" aria-hidden="true" />
                  </button>
                </Show>
              </div>
              <Show when={shouldShowOverlay()}>
                <div class={`prompt-input-overlay ${mode() === "shell" ? "shell-mode" : ""}`}>
                  <Show
                    when={props.escapeInDebounce}
                    fallback={
                      <>
                        <span class="prompt-overlay-text">
                          <Show
                            when={submitOnEnter()}
                            fallback={
                              <>
                                <Kbd>Enter</Kbd> {t("promptInput.overlay.newLine")} • <Kbd shortcut="cmd+enter" /> {t("promptInput.overlay.send")}
                              </>
                            }
                          >
                            <>
                              <Kbd>Enter</Kbd> {t("promptInput.overlay.send")} • <Kbd shortcut="cmd+enter" /> {t("promptInput.overlay.newLine")}
                            </>
                          </Show>
                          {" "}• <Kbd>@</Kbd> {t("promptInput.overlay.filesAgents")} • <Kbd>↑↓</Kbd> {t("promptInput.overlay.history")}
                        </span>
                        <Show when={attachments().length > 0}>
                          <span class="prompt-overlay-text prompt-overlay-muted">{t("promptInput.overlay.attachments", { count: attachments().length })}</span>
                        </Show>
                        <span class="prompt-overlay-text">
                          • <Kbd>{shellHint().key}</Kbd> {shellHint().text}
                        </span>
                        <Show when={mode() !== "shell"}>
                          <span class="prompt-overlay-text">
                            • <Kbd>{commandHint().key}</Kbd> {commandHint().text}
                          </span>
                        </Show>
                        <Show when={mode() === "shell"}>
                          <span class="prompt-overlay-shell-active">{t("promptInput.overlay.shellModeActive")}</span>
                        </Show>
                      </>
                    }
                  >
                    <>
                      <span class="prompt-overlay-text prompt-overlay-warning">
                        {t("promptInput.overlay.press")} <Kbd>Esc</Kbd> {t("promptInput.overlay.againToAbort")}
                      </span>
                      <Show when={mode() === "shell"}>
                        <span class="prompt-overlay-shell-active">{t("promptInput.overlay.shellModeActive")}</span>
                      </Show>
                    </>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>

        <div class="prompt-input-actions">
          <button
            type="button"
            class="stop-button"
            onClick={handleAbort}
            disabled={!canStop()}
            aria-label={t("promptInput.stopSession.ariaLabel")}
            title={t("promptInput.stopSession.title")}
          >
            <svg class="stop-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
          </button>
          <button
            type="button"
            class={`send-button ${mode() === "shell" ? "shell-mode" : ""}`}
            onClick={handleSend}
            disabled={!canSend()}
            aria-label={t("promptInput.send.ariaLabel")}
          >
            <Show
              when={mode() === "shell"}
              fallback={<span class="send-icon">▶</span>}
            >
              <svg class="shell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8l5 4-5 4" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h6" />
              </svg>
            </Show>
          </button>
        </div>
      </div>
    </div>
  )
}
