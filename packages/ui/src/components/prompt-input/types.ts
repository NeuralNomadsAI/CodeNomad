import type { SessionInboxUserPayload } from "@opencode-ai/client"
import type { Attachment } from "../../types/attachment"

export type PromptMode = "normal" | "shell"
export type PickerMode = "mention" | "command"
export type PromptInsertMode = "quote" | "code"
export type PromptDelivery = "steer" | "queue"

export interface PromptInputApi {
  insertSelection(text: string, mode: PromptInsertMode): void
  insertComment(text: string): void
  expandTextAttachment(attachmentId: string): void
  removeAttachment(attachmentId: string): void
  setPromptText(text: string, opts?: { focus?: boolean }): void
  restoreQueuedPrompt(text: string, payload: SessionInboxUserPayload): void
  getPromptText(): string
  focus(): void
}

export interface PromptInputProps {
  instanceId: string
  instanceFolder: string
  sessionId: string

  // Used to scope global "type-to-focus" behavior.
  isActive?: boolean

  // Phone/tablet layouts should keep the expanded prompt more compact.
  compactLayout?: boolean
  onSend: (prompt: string, attachments: Attachment[], delivery: PromptDelivery, restoredPayload?: SessionInboxUserPayload) => Promise<void>
  onCommand?: (commandName: string, args: string) => Promise<void>
  onRunShell?: (command: string) => Promise<void>
  disabled?: boolean
  escapeInDebounce?: boolean
  isSessionBusy?: boolean
  onAbortSession?: () => Promise<void>
  onBackgroundSession?: () => Promise<void>
  registerPromptInputApi?: (api: PromptInputApi) => void | (() => void)
}
