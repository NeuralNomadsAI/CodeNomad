import {
  Suspense,
  createEffect,
  createSignal,
  lazy,
  on,
  onCleanup,
  Show,
} from "solid-js";
import {
  ArrowBigUp,
  ArrowBigDown,
  Loader2,
  Mic,
  Paperclip,
  Volume2,
  X,
} from "lucide-solid";
import ExpandButton from "./expand-button";
import { clearAttachments, removeAttachment } from "../stores/attachments";
import { resolvePastedPlaceholders } from "../lib/prompt-placeholders";
import {
  createPastedPlaceholderRegex,
  pastedDisplayCounterRegex,
} from "./prompt-input/attachmentPlaceholders";
import Kbd from "./kbd";
import { getActiveInstance } from "../stores/instances";
import { agents, executeCustomCommand } from "../stores/sessions";
import { getCommands } from "../stores/commands";
import { showAlertDialog } from "../stores/alerts";
import { useI18n } from "../lib/i18n";
import { getLogger } from "../lib/logger";
import { serverApi } from "../lib/api-client";
import { isDesktopHost, isLocalWindow } from "../lib/runtime-env";
import { preferences } from "../stores/preferences";
import type {
  PromptInputApi,
  PromptInputProps,
  PromptInsertMode,
  PromptMode,
} from "./prompt-input/types";
import type { Attachment } from "../types/attachment";
import type { FileSystemEntry } from "../../../server/src/api-types";
import DirectoryBrowserDialog from "./directory-browser-dialog";
import { usePromptState } from "./prompt-input/usePromptState";
import { usePromptAttachments } from "./prompt-input/usePromptAttachments";
import { usePromptPicker } from "./prompt-input/usePromptPicker";
import { usePromptKeyDown } from "./prompt-input/usePromptKeyDown";
import { usePromptVoiceInput } from "./prompt-input/usePromptVoiceInput";
import {
  canUseConversationMode,
  clearConversationPlaybackForInstance,
  isConversationModeEnabled,
  toggleConversationMode,
} from "../stores/conversation-speech";
const log = getLogger("actions");
const LazyUnifiedPicker = lazy(() => import("./unified-picker"));

function getConsumedPastedTextAttachmentIds(
  text: string,
  attachments: Attachment[],
): string[] {
  if (!text || attachments.length === 0) return [];

  const usedCounters = new Set<string>();
  for (const match of text.matchAll(createPastedPlaceholderRegex())) {
    const counter = match?.[1];
    if (counter) usedCounters.add(counter);
  }

  if (usedCounters.size === 0) return [];

  const consumed = new Set<string>();

  for (const attachment of attachments) {
    if (!attachment?.id) continue;
    if (attachment?.source?.type !== "text") continue;
    const display = attachment.display;
    if (typeof display !== "string") continue;
    const match = display.match(pastedDisplayCounterRegex);
    if (!match?.[1]) continue;
    if (usedCounters.has(match[1])) {
      consumed.add(attachment.id);
    }
  }

  return Array.from(consumed);
}

/**
 * Default height of the prompt input in pixels (compact state).
 * This is the minimum height the input can be resized to.
 */
const DEFAULT_INPUT_HEIGHT = 104;

/**
 * Default expanded height of the prompt input in pixels.
 * Used when clicking the expand button.
 */
const DEFAULT_EXPANDED_HEIGHT = 280;

export default function PromptInput(props: PromptInputProps) {
  const { t } = useI18n();
  const [mode, setMode] = createSignal<PromptMode>("normal");
  const [isFileBrowserOpen, setIsFileBrowserOpen] = createSignal(false);
  const SELECTION_INSERT_MAX_LENGTH = 2000;
  const MAX_READABLE_PICKED_FILE_BYTES = 5 * 1024 * 1024;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  /**
   * Current height of the prompt input container in pixels.
   * Starts at default height and can be resized via drag or button click.
   */
  const [inputHeight, setInputHeight] = createSignal(DEFAULT_INPUT_HEIGHT);

  /**
   * Whether the user is currently dragging the resize handle.
   * Used to apply visual feedback during resize operations.
   */
  const [isResizing, setIsResizing] = createSignal(false);
  let activeResizeHandle: HTMLElement | undefined;
  let activeResizePointerId: number | null = null;
  let activePointerMoveHandler: ((event: PointerEvent) => void) | undefined;
  let activePointerUpHandler: ((event: PointerEvent) => void) | undefined;

  const getPlaceholder = () => {
    if (mode() === "shell") {
      return t("promptInput.placeholder.shell");
    }
    return t("promptInput.placeholder.default");
  };

  const promptState = usePromptState({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
  });

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
  } = promptState;

  const {
    attachments,
    isDragging,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelection,
    handleFilePathAttachment,
    syncAttachmentCounters,
    handleExpandTextAttachment,
    handleRemoveAttachment,
  } = usePromptAttachments({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    disabled: () => Boolean(props.disabled),
  });

  createEffect(() => {
    if (!props.registerPromptInputApi) return;
    const api: PromptInputApi = {
      insertSelection: (text: string, mode: PromptInsertMode) => {
        if (mode === "code") {
          insertCodeSelection(text);
        } else {
          insertQuotedSelection(text);
        }
      },
      insertComment: (text: string) => {
        const normalized = (text ?? "").replace(/\r/g, "").trim();
        if (!normalized) return;
        insertBlockContent(`${normalized}\n\n`);
      },
      expandTextAttachment: (attachmentId: string) => {
        const attachment = attachments().find((a) => a.id === attachmentId);
        if (!attachment) return;
        handleExpandTextAttachment(attachment);
      },
      removeAttachment: (attachmentId: string) => {
        handleRemoveAttachment(attachmentId);
      },
      setPromptText: (text: string, opts?: { focus?: boolean }) => {
        const textarea = textareaRef;
        if (textarea) {
          textarea.value = text;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          if (opts?.focus) {
            try {
              textarea.focus({ preventScroll: true } as any);
            } catch {
              textarea.focus();
            }
          }
          return;
        }

        setPrompt(text);
        if (opts?.focus) {
          setTimeout(() => {
            api.focus();
          }, 0);
        }
      },
      focus: () => {
        const textarea = textareaRef;
        if (!textarea || textarea.disabled) return;
        try {
          textarea.focus({ preventScroll: true } as any);
        } catch {
          textarea.focus();
        }
      },
    };
    const cleanup = props.registerPromptInputApi(api);
    onCleanup(() => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    });
  });

  const instanceAgents = () => agents().get(props.instanceId) || [];

  const promptPicker = usePromptPicker({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    instanceAgents,
    commands: () => getCommands(props.instanceId),
  });

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
  } = promptPicker;

  createEffect(
    on(
      draftLoadedNonce,
      () => {
        // Session switch resets (picker/counters/ignored positions) stay in the component.
        setIgnoredAtPositions(new Set<number>());
        setShowPicker(false);
        setPickerMode("mention");
        setAtPosition(null);
        setSearchQuery("");

        syncAttachmentCounters(prompt());
      },
      { defer: true },
    ),
  );

  const isCoarsePointer = () => {
    if (typeof window === "undefined") return false;
    return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches);
  };

  createEffect(() => {
    // Scope global "type-to-focus" behavior to the active, visible prompt only.
    if (typeof document === "undefined") return;
    if (isCoarsePointer()) return;
    if (props.isActive === false) return;
    if (props.disabled) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const targetElement = e.target instanceof HTMLElement ? e.target : null;

      const isEditableElement = (element: HTMLElement | null) =>
        element?.tagName === "INPUT" ||
        element?.tagName === "TEXTAREA" ||
        element?.tagName === "SELECT" ||
        Boolean(element?.isContentEditable);

      const isInteractiveElement = (element: HTMLElement | null) =>
        Boolean(
          element?.closest(
            'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])',
          ),
        );

      if (
        isEditableElement(activeElement) ||
        isEditableElement(targetElement) ||
        isInteractiveElement(activeElement) ||
        isInteractiveElement(targetElement)
      ) {
        return;
      }

      const isModifierKey = e.ctrlKey || e.metaKey || e.altKey;
      if (isModifierKey) return;

      const isSpecialKey =
        e.key === "Tab" ||
        e.key === "Enter" ||
        e.key.startsWith("Arrow") ||
        e.key === "Backspace" ||
        e.key === "Delete";
      if (isSpecialKey) return;

      const textarea = textareaRef;
      if (!textarea || textarea.disabled) return;

      // In session cache mode inactive panes are display:none; avoid stealing focus.
      if (textarea.offsetParent === null) return;

      if (e.key.length === 1) {
        textarea.focus();
      }
    };

    document.addEventListener("keydown", handleGlobalKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", handleGlobalKeyDown);
    });
  });

  /**
   * Computes the maximum allowed height for the prompt input based on layout.
   * The max height is the distance from the container's top to the toolbar's bottom edge.
   * Falls back to DEFAULT_EXPANDED_HEIGHT if elements are not found.
   */
  function computeMaxHeight(): number {
    if (typeof window === "undefined") return DEFAULT_EXPANDED_HEIGHT;

    if (!containerRef) {
      return Math.max(DEFAULT_INPUT_HEIGHT, window.innerHeight - 100);
    }

    const containerRect = containerRef.getBoundingClientRect();
    const containerBottom = containerRect.bottom;

    // Find the toolbar by looking for the session-toolbar element or AppBar
    const toolbar =
      document.querySelector('[data-session-toolbar="true"]') ||
      document.querySelector(".session-toolbar") ||
      containerRef.closest(".session-view")?.querySelector(".session-toolbar");

    if (toolbar) {
      const toolbarRect = toolbar.getBoundingClientRect();
      const availableHeight = containerBottom - toolbarRect.bottom;
      // Subtract some padding to keep the input from touching the toolbar
      const padding = 16;
      return Math.max(DEFAULT_INPUT_HEIGHT, availableHeight - padding);
    }

    // Fallback: use viewport-based calculation
    const viewportHeight = window.innerHeight;
    const maxFromViewport = viewportHeight - 100;
    return Math.max(DEFAULT_INPUT_HEIGHT, maxFromViewport);
  }

  /**
   * Removes any active global resize listeners and releases pointer capture.
   * This is used both when a drag ends normally and when the component unmounts mid-drag.
   */
  function cleanupResizeTracking(): void {
    if (activePointerMoveHandler) {
      document.removeEventListener("pointermove", activePointerMoveHandler);
      activePointerMoveHandler = undefined;
    }

    if (activePointerUpHandler) {
      document.removeEventListener("pointerup", activePointerUpHandler);
      document.removeEventListener("pointercancel", activePointerUpHandler);
      activePointerUpHandler = undefined;
    }

    if (activeResizeHandle && activeResizePointerId !== null) {
      try {
        activeResizeHandle.releasePointerCapture(activeResizePointerId);
      } catch {
        // Pointer capture may already be released.
      }
    }

    activeResizeHandle = undefined;
    activeResizePointerId = null;
    setIsResizing(false);
  }

  /**
   * Handles the start of a resize drag operation.
   * Captures the pointer and initializes the starting Y position.
   */
  function handleResizeStart(event: PointerEvent) {
    event.preventDefault();
    cleanupResizeTracking();
    setIsResizing(true);

    // Capture the pointer to ensure we receive events even if cursor leaves the handle
    const target = event.currentTarget as HTMLElement;
    activeResizeHandle = target;
    activeResizePointerId = event.pointerId;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture not supported, continue without it
    }

    // Store initial values for the drag operation
    const startY = event.clientY;
    const startHeight = inputHeight();
    const computedMax = computeMaxHeight();

    /**
     * Handles pointer movement during resize drag.
     * Calculates new height based on drag direction and clamps to bounds.
     * Dragging up increases height (makes input taller).
     */
    function handlePointerMove(moveEvent: PointerEvent) {
      moveEvent.preventDefault();
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(
        DEFAULT_INPUT_HEIGHT,
        Math.min(computedMax, startHeight + deltaY),
      );
      setInputHeight(newHeight);
    }

    /**
     * Handles the end of a resize drag operation.
     * Releases pointer capture and removes event listeners.
     */
    function handlePointerUp(upEvent: PointerEvent) {
      upEvent.preventDefault();
      cleanupResizeTracking();
      // Restore focus to textarea after resize
      textareaRef?.focus();
    }

    activePointerMoveHandler = handlePointerMove;
    activePointerUpHandler = handlePointerUp;
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
  }

  onCleanup(() => {
    cleanupResizeTracking();
  });

  async function handleSend() {
    const text = prompt().trim();
    const currentAttachments = attachments();
    if (props.disabled || (!text && currentAttachments.length === 0)) return;

    const isShellMode = mode() === "shell";

    // Slash command routing (match OpenCode TUI): only run if the command exists.
    const isSlashCandidate = !isShellMode && text.startsWith("/");
    const firstSpace = isSlashCandidate ? text.indexOf(" ") : -1;
    const commandToken = isSlashCandidate
      ? firstSpace === -1
        ? text
        : text.slice(0, firstSpace)
      : "";
    const commandName = isSlashCandidate ? commandToken.slice(1) : "";
    const commandArgs = isSlashCandidate
      ? firstSpace === -1
        ? ""
        : text.slice(firstSpace + 1).trimStart()
      : "";

    const isKnownSlashCommand =
      isSlashCandidate &&
      commandName.length > 0 &&
      getCommands(props.instanceId).some((cmd) => cmd.name === commandName);

    const resolvedCommandArgs = isKnownSlashCommand
      ? resolvePastedPlaceholders(commandArgs, currentAttachments)
      : "";
    const resolvedPrompt = isKnownSlashCommand
      ? resolvedCommandArgs
        ? `${commandToken} ${resolvedCommandArgs}`
        : commandToken
      : resolvePastedPlaceholders(text, currentAttachments);
    const historyEntry = resolvedPrompt;

    const refreshHistory = () => recordHistoryEntry(historyEntry);

    // Reset the input height to the default size before sending.
    setInputHeight(DEFAULT_INPUT_HEIGHT);
    clearPrompt();
    clearHistoryDraft();
    setMode("normal");

    // Ignore attachments for slash commands, but keep them for next prompt.
    if (!isKnownSlashCommand) {
      clearAttachments(props.instanceId, props.sessionId);
      syncAttachmentCounters("");
      setIgnoredAtPositions(new Set<number>());
    } else {
      const consumedIds = getConsumedPastedTextAttachmentIds(
        commandArgs,
        currentAttachments,
      );
      for (const attachmentId of consumedIds) {
        removeAttachment(props.instanceId, props.sessionId, attachmentId);
      }
      syncAttachmentCounters("");
      setIgnoredAtPositions(new Set<number>());
    }
    if (isKnownSlashCommand) {
      // Record attempted slash commands even if execution fails.
      void refreshHistory();
    }

    try {
      if (isShellMode) {
        if (props.onRunShell) {
          await props.onRunShell(resolvedPrompt);
        } else {
          await props.onSend(resolvedPrompt, []);
        }
      } else if (isKnownSlashCommand) {
        await executeCustomCommand(
          props.instanceId,
          props.sessionId,
          commandName,
          resolvedCommandArgs,
        );
      } else {
        await props.onSend(resolvedPrompt, currentAttachments);
      }
      if (!isKnownSlashCommand) {
        void refreshHistory();
      }
    } catch (error) {
      log.error("Failed to send message:", error);
      showAlertDialog(t("promptInput.send.errorFallback"), {
        title: t("promptInput.send.errorTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      });
    } finally {
      textareaRef?.focus();
    }
  }

  function handleAbort() {
    if (!props.onAbortSession || !props.isSessionBusy) return;
    void props.onAbortSession();
  }

  /**
   * Handles expand/shrink button clicks.
   * When expand=true, sets height to default expanded height (clamped to max).
   * When expand=false, resets height to default/minimum height.
   * Preserves textarea focus after the operation.
   */
  function handleExpandToggle(expand: boolean) {
    if (expand) {
      const computedMax = computeMaxHeight();
      setInputHeight(Math.min(DEFAULT_EXPANDED_HEIGHT, computedMax));
    } else {
      setInputHeight(DEFAULT_INPUT_HEIGHT);
    }
    // Keep focus on textarea after toggling
    textareaRef?.focus();
  }

  function handleClearPrompt() {
    clearPrompt();
    clearHistoryDraft();
    resetHistoryNavigation();
    setShowPicker(false);
    setPickerMode("mention");
    setAtPosition(null);
    setSearchQuery("");
    setIgnoredAtPositions(new Set<number>());
    syncAttachmentCounters("");
    textareaRef?.focus();
  }

  async function handleAttachFiles() {
    if (props.disabled) return;
    if (isDesktopHost() && isLocalWindow()) {
      fileInputRef?.click();
      return;
    }
    setIsFileBrowserOpen(true);
  }

  async function handleFileBrowserSelect(
    path: string,
    entry?: FileSystemEntry,
  ) {
    if (props.disabled) return;
    if (
      typeof entry?.size === "number" &&
      entry.size > MAX_READABLE_PICKED_FILE_BYTES
    ) {
      showAlertDialog(t("promptInput.attachFiles.tooLarge.one"), {
        title: t("promptInput.attachFiles.skipped.title"),
        variant: "warning",
      });
      textareaRef?.focus();
      return;
    }
    try {
      const filePath = entry?.path ?? path;
      const displayPath = entry?.absolutePath ?? path;
      const response = await serverApi.readFileSystemFile(filePath, {
        encoding: "base64",
      });
      handleFilePathAttachment(displayPath, response.contents, {
        encoding: response.encoding,
      });
      setIsFileBrowserOpen(false);
    } catch (error) {
      log.error("Failed to attach selected file:", error);
      showAlertDialog(error instanceof Error ? error.message : String(error), {
        title: t("promptInput.attachFiles.errorTitle"),
        variant: "error",
      });
    } finally {
      textareaRef?.focus();
    }
  }

  function handleFileInputChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (props.disabled) {
      input.value = "";
      return;
    }
    handleFileSelection(input.files);
    input.value = "";
  }

  function insertBlockContent(block: string) {
    const textarea = textareaRef;
    const current = prompt();
    const start = textarea ? textarea.selectionStart : current.length;
    const end = textarea ? textarea.selectionEnd : current.length;
    const before = current.substring(0, start);
    const after = current.substring(end);
    const needsLeading =
      before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    const insertion = `${needsLeading}${block}`;
    const nextValue = before + insertion + after;

    setPrompt(nextValue);
    setShowPicker(false);
    setAtPosition(null);

    if (textarea) {
      setTimeout(() => {
        const cursor = before.length + insertion.length;
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
      }, 0);
    }
  }

  function insertQuotedSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "").trim();
    if (!normalized) return;
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH).trimEnd()
        : normalized;
    const lines = limited
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;

    const blockquote = lines.map((line) => `> ${line}`).join("\n");
    if (!blockquote) return;

    // End the blockquote with a blank line so the user's next line
    // doesn't get parsed as a lazy continuation of the quote.
    insertBlockContent(`${blockquote}\n\n`);
  }

  function insertCodeSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "");
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH)
        : normalized;
    const trimmed = limited.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!trimmed) return;

    const block = "```\n" + trimmed + "\n```\n\n";
    insertBlockContent(block);
  }

  const canStop = () => Boolean(props.isSessionBusy && props.onAbortSession);

  const hasHistory = () => history().length > 0;
  const canHistoryGoPrevious = () =>
    hasHistory() &&
    (historyIndex() === -1 || historyIndex() < history().length - 1);
  const canHistoryGoNext = () => historyIndex() >= 0;

  const canSend = () => {
    if (props.disabled) return false;
    const hasText = prompt().trim().length > 0;
    if (mode() === "shell") return hasText;
    return hasText || attachments().length > 0;
  };

  const canClearPrompt = () => prompt().length > 0;

  const shellHint = () =>
    mode() === "shell"
      ? { key: "Esc", text: t("promptInput.hints.shell.exit") }
      : { key: "!", text: t("promptInput.hints.shell.enable") };
  const commandHint = () => ({
    key: "/",
    text: t("promptInput.hints.commands"),
  });

  const submitOnEnter = () => preferences().promptSubmitOnEnter;

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
    removeAttachment: (attachmentId) =>
      removeAttachment(props.instanceId, props.sessionId, attachmentId),
    submitOnEnter,
    onSend: () => void handleSend(),
    selectPreviousHistory: (force) =>
      selectPreviousHistory({
        force,
        isPickerOpen: showPicker(),
        getTextarea: () => textareaRef ?? null,
      }),
    selectNextHistory: (force) =>
      selectNextHistory({
        force,
        isPickerOpen: showPicker(),
        getTextarea: () => textareaRef ?? null,
      }),
  });

  const shouldShowOverlay = () => prompt().length === 0;
  const voiceInput = usePromptVoiceInput({
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    enabled: () => preferences().showPromptVoiceInput,
    disabled: () => Boolean(props.disabled),
  });
  const showVoiceInput = () =>
    preferences().showPromptVoiceInput &&
    (voiceInput.canUseVoiceInput() ||
      voiceInput.isRecording() ||
      voiceInput.isTranscribing());
  const conversationModeEnabled = () =>
    isConversationModeEnabled(props.instanceId);
  const showConversationToggle = () =>
    showVoiceInput() || conversationModeEnabled();
  const canToggleConversationMode = () => canUseConversationMode();
  const conversationModeButtonTitle = () =>
    conversationModeEnabled()
      ? t("promptInput.conversationMode.disable.title")
      : t("promptInput.conversationMode.enable.title");

  const instance = () => getActiveInstance();

  let voiceButtonPressed = false;

  const beginVoicePress = (event?: PointerEvent | KeyboardEvent) => {
    if (
      voiceButtonPressed ||
      props.disabled ||
      voiceInput.isTranscribing() ||
      !voiceInput.canUseVoiceInput()
    )
      return;
    voiceButtonPressed = true;
    // Treat a mic press as barge-in: stop any active assistant speech before listening.
    clearConversationPlaybackForInstance(props.instanceId);

    if (event instanceof PointerEvent) {
      const target = event.currentTarget;
      if (target instanceof HTMLElement) {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // no-op
        }
      }
    }

    void voiceInput.startRecording();
  };

  const endVoicePress = () => {
    if (!voiceButtonPressed) return;
    voiceButtonPressed = false;
    voiceInput.stopRecording();
  };

  return (
    <div class="prompt-input-container">
      {/* Resize handle at the top edge of the input container */}
      <div
        class={`prompt-resize-handle ${isResizing() ? "is-resizing" : ""}`}
        onPointerDown={handleResizeStart}
        aria-label={t("promptInput.resizeHandle.ariaLabel")}
        title={t("promptInput.resizeHandle.title")}
      />
      <div
        ref={containerRef}
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2" : ""}`}
        style={{
          height: `${inputHeight()}px`,
          ...(isDragging()
            ? {
                "border-color": "var(--accent-primary)",
                "background-color": "rgba(0, 102, 255, 0.05)",
              }
            : {}),
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Show when={showPicker() && instance()}>
          <Suspense fallback={null}>
            <LazyUnifiedPicker
              open={showPicker()}
              mode={pickerMode()}
              onClose={handlePickerClose}
              onSelect={handlePickerSelect}
              onSubmitWithoutSelection={() => {
                handlePickerClose();
                void handleSend();
              }}
              agents={instanceAgents()}
              commands={getCommands(props.instanceId)}
              instanceClient={instance()!.client}
              searchQuery={searchQuery()}
              textareaRef={textareaRef}
              workspaceId={props.instanceId}
            />
          </Suspense>
        </Show>

        <div class="prompt-input-main flex flex-1 flex-col">
          <div class="prompt-input-field-container">
            <div class="prompt-input-field">
              <textarea
                ref={textareaRef}
                class={`prompt-input ${mode() === "shell" ? "shell-mode" : ""}`}
                dir="auto"
                placeholder={getPlaceholder()}
                value={prompt()}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                disabled={props.disabled}
                rows={3}
                spellcheck={false}
                autocorrect="off"
                autoCapitalize="off"
                autocomplete="off"
              />
              <Show when={shouldShowOverlay()}>
                <div
                  class={`prompt-input-overlay keyboard-hints ${mode() === "shell" ? "shell-mode" : ""}`}
                >
                  <Show
                    when={props.escapeInDebounce}
                    fallback={
                      <>
                        <span class="prompt-overlay-text">
                          <Show
                            when={submitOnEnter()}
                            fallback={
                              <>
                                <Kbd>Enter</Kbd>{" "}
                                {t("promptInput.overlay.newLine")} •{" "}
                                <Kbd shortcut="cmd+enter" />{" "}
                                {t("promptInput.overlay.send")}
                              </>
                            }
                          >
                            <>
                              <Kbd>Enter</Kbd> {t("promptInput.overlay.send")} •{" "}
                              <Kbd shortcut="cmd+enter" />{" "}
                              {t("promptInput.overlay.newLine")}
                            </>
                          </Show>{" "}
                          • <Kbd>↑↓</Kbd> {t("promptInput.overlay.history")}
                        </span>
                        <Show when={attachments().length > 0}>
                          <span class="prompt-overlay-text prompt-overlay-muted">
                            {t("promptInput.overlay.attachments", {
                              count: attachments().length,
                            })}
                          </span>
                        </Show>
                        <span class="prompt-overlay-text">
                          • <Kbd>{shellHint().key}</Kbd> {shellHint().text}
                        </span>
                        <Show when={mode() !== "shell"}>
                          <span class="prompt-overlay-text">
                            • <Kbd>{commandHint().key}</Kbd>{" "}
                            {commandHint().text}
                          </span>
                        </Show>
                        <Show when={mode() === "shell"}>
                          <span class="prompt-overlay-shell-active">
                            {t("promptInput.overlay.shellModeActive")}
                          </span>
                        </Show>
                      </>
                    }
                  >
                    <>
                      <span class="prompt-overlay-text prompt-overlay-warning">
                        {t("promptInput.overlay.press")} <Kbd>Esc</Kbd>{" "}
                        {t("promptInput.overlay.againToAbort")}
                      </span>
                      <Show when={mode() === "shell"}>
                        <span class="prompt-overlay-shell-active">
                          {t("promptInput.overlay.shellModeActive")}
                        </span>
                      </Show>
                    </>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>

        <div class="prompt-input-actions">
          <div class="prompt-nav-buttons">
            <div class="prompt-nav-column prompt-nav-column-left">
              <Show when={showVoiceInput()}>
                <button
                  type="button"
                  class={`prompt-voice-button prompt-nav-voice-button ${voiceInput.isRecording() ? "is-recording" : ""}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    beginVoicePress(event);
                  }}
                  onPointerUp={(event) => {
                    event.preventDefault();
                    endVoicePress();
                  }}
                  onPointerCancel={() => endVoicePress()}
                  onLostPointerCapture={() => endVoicePress()}
                  onKeyDown={(event) => {
                    if (event.repeat) return;
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    beginVoicePress(event);
                  }}
                  onKeyUp={(event) => {
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    endVoicePress();
                  }}
                  onBlur={() => endVoicePress()}
                  disabled={
                    !voiceInput.isRecording() &&
                    (props.disabled ||
                      voiceInput.isTranscribing() ||
                      !voiceInput.canUseVoiceInput())
                  }
                  aria-label={voiceInput.buttonTitle()}
                  title={voiceInput.buttonTitle()}
                >
                  <Show
                    when={voiceInput.isRecording()}
                    fallback={
                      <Show
                        when={voiceInput.isTranscribing()}
                        fallback={<Mic class="h-4 w-4" aria-hidden="true" />}
                      >
                        <Loader2
                          class="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      </Show>
                    }
                  >
                    <Mic class="h-4 w-4" aria-hidden="true" />
                  </Show>
                </button>
              </Show>
              <Show when={showConversationToggle()}>
                <button
                  type="button"
                  class={`prompt-voice-button prompt-nav-voice-button prompt-conversation-button ${conversationModeEnabled() ? "is-active" : ""}`}
                  onClick={() => toggleConversationMode(props.instanceId)}
                  disabled={
                    !conversationModeEnabled() && !canToggleConversationMode()
                  }
                  aria-pressed={conversationModeEnabled()}
                  aria-label={conversationModeButtonTitle()}
                  title={conversationModeButtonTitle()}
                >
                  <Volume2 class="h-4 w-4" aria-hidden="true" />
                </button>
              </Show>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                class="sr-only"
                tabindex="-1"
                disabled={props.disabled}
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                class="prompt-attach-button"
                onClick={handleAttachFiles}
                disabled={props.disabled}
                aria-label={t("promptInput.attachFiles.ariaLabel")}
                title={t("promptInput.attachFiles.title")}
              >
                <Paperclip class="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="prompt-clear-button"
                onClick={handleClearPrompt}
                disabled={!canClearPrompt()}
                aria-label={t("promptInput.clear.ariaLabel")}
                title={t("promptInput.clear.title")}
              >
                <X class="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div class="prompt-nav-column prompt-nav-column-right">
              <ExpandButton
                currentHeight={inputHeight}
                defaultHeight={() => DEFAULT_INPUT_HEIGHT}
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
          </div>
        </div>

        <div class="prompt-input-primary-actions">
          <button
            type="button"
            class="stop-button"
            onClick={handleAbort}
            disabled={!canStop()}
            aria-label={t("promptInput.stopSession.ariaLabel")}
            title={t("promptInput.stopSession.title")}
          >
            <svg
              class="stop-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
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
              <svg
                class="shell-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5 8l5 4-5 4"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M13 16h6"
                />
              </svg>
            </Show>
          </button>
        </div>
      </div>

      <DirectoryBrowserDialog
        open={isFileBrowserOpen()}
        mode="files"
        title={t("promptInput.attachFiles.dialogTitle")}
        onClose={() => {
          setIsFileBrowserOpen(false);
          textareaRef?.focus();
        }}
        onSelect={(path, entry) => void handleFileBrowserSelect(path, entry)}
        initialPath={props.instanceFolder}
      />
    </div>
  );
}
