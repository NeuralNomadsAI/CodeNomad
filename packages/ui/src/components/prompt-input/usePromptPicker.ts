import { createSignal, type Accessor, type Setter } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk/v2"
import type { Agent } from "../../types/session"
import { createAgentAttachment, createFileAttachment } from "../../types/attachment"
import { addAttachment, getAttachments } from "../../stores/attachments"
import type { PickerMode } from "./types"

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
  handlePickerSelect: (item: PickerItem) => void
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

  function handlePickerSelect(item: PickerItem) {
    const textarea = options.getTextarea()

    if (item.type === "command") {
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

      if (isFolder) {
        const currentPrompt = options.prompt()
        const pos = atPosition()
        const cursorPos = textarea?.selectionStart || 0
        const folderMention =
          relativePath === "." || relativePath === ""
            ? "/"
            : relativePath.replace(/\/+$/, "") + "/"

        if (pos !== null) {
          const before = currentPrompt.substring(0, pos + 1)
          const after = currentPrompt.substring(cursorPos)
          const newPrompt = before + folderMention + after
          options.setPrompt(newPrompt)
          setSearchQuery(folderMention)

          setTimeout(() => {
            const nextTextarea = options.getTextarea()
            if (nextTextarea) {
              const newCursorPos = pos + 1 + folderMention.length
              nextTextarea.setSelectionRange(newCursorPos, newCursorPos)
            }
          }, 0)
        }

        return
      }

      const normalizedPath = relativePath.replace(/\/+$/, "") || relativePath
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

      const currentPrompt = options.prompt()
      const pos = atPosition()
      const cursorPos = textarea?.selectionStart || 0

      if (pos !== null) {
        const before = currentPrompt.substring(0, pos)
        const after = currentPrompt.substring(cursorPos)
        const attachmentText = `@${normalizedPath}`
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
