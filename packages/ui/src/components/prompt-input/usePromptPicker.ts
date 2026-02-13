import { createSignal, type Accessor, type Setter } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk/v2"
import type { Agent } from "../../types/session"
import { createAgentAttachment, createFileAttachment, createTextAttachment } from "../../types/attachment"
import { addAttachment, getAttachments } from "../../stores/attachments"
import type { PickerMode } from "./types"
import type { PickerSelectAction } from "../unified-picker"

type PickerItem =
  | { type: "agent"; agent: Agent }
  | { type: "file"; file: { path: string; relativePath?: string; isGitFile: boolean; isDirectory?: boolean } }
  | { type: "command"; command: SDKCommand }

type PromptPickerOptions = {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>

  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null

  instanceAgents: Accessor<Agent[]>
  commands: Accessor<SDKCommand[]>
}

type PromptPickerController = {
  showPicker: Accessor<boolean>
  pickerMode: Accessor<PickerMode>
  searchQuery: Accessor<string>
  atPosition: Accessor<number | null>
  ignoredAtPositions: Accessor<Set<number>>

  setShowPicker: Setter<boolean>
  setPickerMode: Setter<PickerMode>
  setSearchQuery: Setter<string>
  setAtPosition: Setter<number | null>
  setIgnoredAtPositions: Setter<Set<number>>

  handleInput: (e: Event) => void
  handlePickerSelect: (item: PickerItem, action: PickerSelectAction) => void
  handlePickerClose: () => void
}

export function usePromptPicker(options: PromptPickerOptions): PromptPickerController {
  const [showPicker, setShowPicker] = createSignal(false)
  const [pickerMode, setPickerMode] = createSignal<PickerMode>("mention")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [atPosition, setAtPosition] = createSignal<number | null>(null)
  const [ignoredAtPositions, setIgnoredAtPositions] = createSignal<Set<number>>(new Set<number>())

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement
    const value = target.value
    options.setPrompt(value)

    const cursorPos = target.selectionStart

    // Slash command picker (only when editing the command token: "/<query>")
    if (value.startsWith("/") && cursorPos >= 1) {
      const firstWhitespaceIndex = value.slice(1).search(/\s/)
      const tokenEnd = firstWhitespaceIndex === -1 ? value.length : firstWhitespaceIndex + 1

      if (cursorPos <= tokenEnd) {
        setPickerMode("command")
        setAtPosition(0)
        setSearchQuery(value.substring(1, cursorPos))
        setShowPicker(true)
        return
      }
    }

    const textBeforeCursor = value.substring(0, cursorPos)
    const lastAtIndex = textBeforeCursor.lastIndexOf("@")

    const previousAtPosition = atPosition()

    if (lastAtIndex === -1) {
      setIgnoredAtPositions(new Set<number>())
    } else if (previousAtPosition !== null && lastAtIndex !== previousAtPosition) {
      setIgnoredAtPositions((prev) => {
        const next = new Set(prev)
        next.delete(previousAtPosition)
        return next
      })
    }

    if (lastAtIndex !== -1) {
      const textAfterAt = value.substring(lastAtIndex + 1, cursorPos)
      const hasSpace = textAfterAt.includes(" ") || textAfterAt.includes("\n")

      if (!hasSpace && cursorPos === lastAtIndex + textAfterAt.length + 1) {
        if (!ignoredAtPositions().has(lastAtIndex)) {
          setPickerMode("mention")
          setAtPosition(lastAtIndex)
          setSearchQuery(textAfterAt)
          setShowPicker(true)
        }
        return
      }
    }

    setShowPicker(false)
    setAtPosition(null)
  }

  function handlePickerSelect(item: PickerItem, action: PickerSelectAction) {
    const textarea = options.getTextarea()

    if (item.type === "command") {
      // For commands, Tab/Enter/Shift+Enter/click all mean "select".
      const name = item.command.name
      const currentPrompt = options.prompt()

      const afterSlash = currentPrompt.slice(1)
      const firstWhitespaceIndex = afterSlash.search(/\s/)
      const tokenEnd = firstWhitespaceIndex === -1 ? currentPrompt.length : firstWhitespaceIndex + 1

      const before = ""
      const after = currentPrompt.substring(tokenEnd)
      const newPrompt = before + `/${name} ` + after
      options.setPrompt(newPrompt)

      setTimeout(() => {
        const nextTextarea = options.getTextarea()
        if (nextTextarea) {
          const newCursorPos = `/${name} `.length
          nextTextarea.setSelectionRange(newCursorPos, newCursorPos)
          nextTextarea.focus()
        }
      }, 0)
    } else if (item.type === "agent") {
      // For agents, Tab/Enter/Shift+Enter/click all mean "select".
      const agentName = item.agent.name
      const existingAttachments = getAttachments(options.instanceId(), options.sessionId())
      const alreadyAttached = existingAttachments.some(
        (att) => att.source.type === "agent" && att.source.name === agentName,
      )

      if (!alreadyAttached) {
        const attachment = createAgentAttachment(agentName)
        addAttachment(options.instanceId(), options.sessionId(), attachment)
      }

      const currentPrompt = options.prompt()
      const pos = atPosition()
      const cursorPos = textarea?.selectionStart || 0

      if (pos !== null) {
        const before = currentPrompt.substring(0, pos)
        const after = currentPrompt.substring(cursorPos)
        const attachmentText = `@${agentName}`
        const newPrompt = before + attachmentText + " " + after
        options.setPrompt(newPrompt)

        setTimeout(() => {
          const nextTextarea = options.getTextarea()
          if (nextTextarea) {
            const newCursorPos = pos + attachmentText.length + 1
            nextTextarea.setSelectionRange(newCursorPos, newCursorPos)
          }
        }, 0)
      }
    } else if (item.type === "file") {
      const displayPath = item.file.path
      const relativePath = item.file.relativePath ?? displayPath
      const isFolder = item.file.isDirectory ?? displayPath.endsWith("/")

      const pos = atPosition()
      const cursorPos = textarea?.selectionStart || 0

      const replaceMentionToken = (mentionText: string, opts?: { trailingSpace?: boolean }) => {
        if (pos === null) return
        const currentPrompt = options.prompt()
        const before = currentPrompt.substring(0, pos)
        const after = currentPrompt.substring(cursorPos)
        const suffix = opts?.trailingSpace ? " " : ""
        const nextPrompt = before + mentionText + suffix + after
        options.setPrompt(nextPrompt)

        setTimeout(() => {
          const nextTextarea = options.getTextarea()
          if (!nextTextarea) return
          const nextCursorPos = pos + mentionText.length + suffix.length
          nextTextarea.setSelectionRange(nextCursorPos, nextCursorPos)
        }, 0)
      }

      const replaceMentionQueryAfterAt = (value: string) => {
        // Replaces only the query after '@' (keeps the '@' itself). Used for directory navigation.
        if (pos === null) return
        const currentPrompt = options.prompt()
        const before = currentPrompt.substring(0, pos + 1)
        const after = currentPrompt.substring(cursorPos)
        const nextPrompt = before + value + after
        options.setPrompt(nextPrompt)

        setTimeout(() => {
          const nextTextarea = options.getTextarea()
          if (!nextTextarea) return
          const nextCursorPos = pos + 1 + value.length
          nextTextarea.setSelectionRange(nextCursorPos, nextCursorPos)
        }, 0)
      }

      const folderMention =
        relativePath === "." || relativePath === ""
          ? "/"
          : relativePath.replace(/\/+$/, "") + "/"

      const normalizedFolderPath = (() => {
        const trimmed = relativePath.replace(/\/+$/, "")
        return trimmed.length > 0 ? trimmed : "."
      })()

      const addPathOnlyAttachment = (value: string) => {
        const display = `path: ${value}`
        const filename = value
        const existing = getAttachments(options.instanceId(), options.sessionId())
        const alreadyAttached = existing.some(
          (att) => att.source.type === "text" && att.source.value === value && att.display === display,
        )
        if (!alreadyAttached) {
          addAttachment(options.instanceId(), options.sessionId(), createTextAttachment(value, display, filename))
        }
      }

      if (isFolder) {
        if (action === "tab") {
          // TAB on directory: autocomplete directory name and show its contents.
          replaceMentionQueryAfterAt(folderMention)
          setSearchQuery(folderMention)
          return
        }

        const mentionText = `@${folderMention}`

        if (action === "shiftEnter") {
          // SHIFT+ENTER on directory: attach path as text only.
          addPathOnlyAttachment(folderMention)
          replaceMentionToken(mentionText, { trailingSpace: true })
        } else {
          // ENTER/click on directory: attach as a file part pointing at a file:// directory URL.
          const dirLabel =
            normalizedFolderPath === "." ? "/" : normalizedFolderPath.split("/").pop() || normalizedFolderPath
          const dirFilename = dirLabel.endsWith("/") ? dirLabel : `${dirLabel}/`

          const existingAttachments = getAttachments(options.instanceId(), options.sessionId())
          const alreadyAttached = existingAttachments.some(
            (att) => att.source.type === "file" && att.source.path === normalizedFolderPath && att.source.mime === "inode/directory",
          )

          if (!alreadyAttached) {
            const attachment = createFileAttachment(
              normalizedFolderPath,
              dirFilename,
              "inode/directory",
              undefined,
              options.instanceFolder(),
            )
            addAttachment(options.instanceId(), options.sessionId(), attachment)
          }

          replaceMentionToken(mentionText, { trailingSpace: true })
        }
      } else {
        const normalizedPath = relativePath.replace(/\/+$/, "") || relativePath

        if (action === "tab") {
          // TAB on file: autocomplete the file path but do not attach.
          replaceMentionToken(`@${normalizedPath}`)
          setSearchQuery(normalizedPath)
          return
        }

        if (action === "shiftEnter") {
          // SHIFT+ENTER on file: attach path as text only.
          addPathOnlyAttachment(normalizedPath)
          replaceMentionToken(`@${normalizedPath}`, { trailingSpace: true })
        } else {
          // ENTER/click on file: attach file (existing behavior).
          const pathSegments = normalizedPath.split("/")
          const filename = (() => {
            const candidate = pathSegments[pathSegments.length - 1] || normalizedPath
            return candidate === "." ? "/" : candidate
          })()

          const existingAttachments = getAttachments(options.instanceId(), options.sessionId())
          const alreadyAttached = existingAttachments.some(
            (att) => att.source.type === "file" && att.source.path === normalizedPath,
          )

          if (!alreadyAttached) {
            const attachment = createFileAttachment(
              normalizedPath,
              filename,
              "text/plain",
              undefined,
              options.instanceFolder(),
            )
            addAttachment(options.instanceId(), options.sessionId(), attachment)
          }

          replaceMentionToken(`@${normalizedPath}`, { trailingSpace: true })
        }
      }
    }

    setShowPicker(false)
    setAtPosition(null)
    setSearchQuery("")
    textarea?.focus()
  }

  function handlePickerClose() {
    const pos = atPosition()
    if (pickerMode() === "mention" && pos !== null) {
      setIgnoredAtPositions((prev) => new Set(prev).add(pos))
    }
    setShowPicker(false)
    setAtPosition(null)
    setSearchQuery("")
    setTimeout(() => options.getTextarea()?.focus(), 0)
  }

  return {
    showPicker,
    pickerMode,
    searchQuery,
    atPosition,
    ignoredAtPositions,

    setShowPicker,
    setPickerMode,
    setSearchQuery,
    setAtPosition,
    setIgnoredAtPositions,

    handleInput,
    handlePickerSelect,
    handlePickerClose,
  }
}
