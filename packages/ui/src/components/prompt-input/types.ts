import type { Attachment } from "../../types/attachment"

export type PromptMode = "normal" | "shell"
export type ExpandState = "normal" | "expanded"
export type PickerMode = "mention" | "command"
export type PromptInsertMode = "quote" | "code"

export interface PromptInputApi {
  insertSelection(text: string, mode: PromptInsertMode): void
  expandTextAttachment(attachmentId: string): void
  setPromptText(text: string, opts?: { focus?: boolean }): void
  focus(): void
}

export interface PromptInputProps {
  instanceId: string
  instanceFolder: string
  sessionId: string
  onSend: (prompt: string, attachments: Attachment[]) => Promise<void>
  onRunShell?: (command: string) => Promise<void>
  disabled?: boolean
  escapeInDebounce?: boolean
  isSessionBusy?: boolean
  onAbortSession?: () => Promise<void>
  registerPromptInputApi?: (api: PromptInputApi) => void | (() => void)
}
