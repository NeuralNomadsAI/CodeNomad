import { batch, createComputed, createSignal, onCleanup, type Accessor } from "solid-js"
import { PROMPT_INLINE_FILE_LIMITS } from "../../../../server/src/api-types"
import { addAttachment, getAttachments } from "../../stores/attachments"
import { createFileAttachment } from "../../types/attachment"
import { tGlobal } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import { getInlineFileUsage, readDeviceFileSelection } from "./device-file-selection"
import { findHighestAttachmentCounters, formatImagePlaceholder } from "./attachmentPlaceholders"

interface Options {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>
  active?: Accessor<boolean>
  disabled?: Accessor<boolean>
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  inferMime: (name: string) => string
}

// Each picker and read owns an epoch, not just matching IDs. Returning A → B → A
// must never revive a read or focus callback belonging to the earlier draft.
export function useDeviceAttachments(options: Options) {
  const [generation, setGeneration] = createSignal(0)
  const [pending, setPending] = createSignal(0)
  let disposed = false
  let tail = Promise.resolve()
  let picker: HTMLInputElement | undefined
  let identity: string | undefined
  const available = () => !disposed && options.active?.() !== false && !options.disabled?.()
  createComputed(() => {
    const nextIdentity = JSON.stringify([options.instanceId(), options.sessionId(), options.instanceFolder(), options.active?.() !== false, Boolean(options.disabled?.())])
    if (nextIdentity === identity) return
    identity = nextIdentity
    setGeneration(value => value + 1)
    setPending(0)
    tail = Promise.resolve()
    // The native dialog may still deliver a change to its detached input. Its
    // callback retains its original guard and cannot write into this generation.
    picker?.remove()
    picker = undefined
  })
  onCleanup(() => { disposed = true; picker?.remove() })

  function capture() {
    const epoch = generation()
    const instanceId = options.instanceId(), sessionId = options.sessionId(), folder = options.instanceFolder()
    return {
      instanceId, sessionId, folder,
      current: () => available() && generation() === epoch,
    }
  }

  function focus(owner: ReturnType<typeof capture>) {
    if (!owner.current()) return
    const textarea = options.getTextarea()
    if (textarea?.isConnected && textarea.offsetParent !== null) textarea.focus()
  }

  function enqueue(files: readonly File[], clipboard = false, owner = capture()): Promise<void> {
    if (!owner.current() || !files.length) return Promise.resolve()
    const input = options.getTextarea()
    const anchor = { text: options.prompt(), start: input?.selectionStart ?? options.prompt().length,
      end: input?.selectionEnd ?? options.prompt().length }
    setPending(value => value + 1)
    const run = async () => {
      if (!owner.current()) return
      try {
        const result = await readDeviceFileSelection(files, getAttachments(owner.instanceId, owner.sessionId), owner.current)
        if (result.stale || !owner.current()) return
        const textarea = options.getTextarea()
        const insertion = clipboardInsertion(anchor, options.prompt())
        const selection = textarea && { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection }
        const unchangedSelection = selection && options.prompt() === anchor.text
          && selection.start === anchor.start && selection.end === anchor.end
        let cursor = insertion.start
        let selectionEnd = insertion.end
        let inserted = false
        batch(() => {
          for (const { file, data } of result.files) {
            const usage = getInlineFileUsage(getAttachments(owner.instanceId, owner.sessionId))
            if (usage.count >= PROMPT_INLINE_FILE_LIMITS.maxFiles || usage.bytes + data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes) {
              result.rejected.push({ name: file.name, reason: "limit" })
              continue
            }
            const mime = file.type || options.inferMime(file.name)
            const attachment = createFileAttachment(file.name, file.name, mime, data, owner.folder)
            attachment.url = `data:${mime};base64,${encodeBase64(data)}`
            if (clipboard && mime.startsWith("image/")) {
              const count = findHighestAttachmentCounters(options.prompt()).highestImage + 1
              const token = formatImagePlaceholder(count)
              const text = options.prompt()
              options.setPrompt(text.slice(0, cursor) + token + text.slice(selectionEnd))
              cursor += token.length
              selectionEnd = cursor
              inserted = true
              attachment.display = token
            }
            addAttachment(owner.instanceId, owner.sessionId, attachment)
          }
        })
        if (inserted && textarea && selection) {
          const mapPosition = (position: number) => position < insertion.start ? position
            : position >= insertion.end ? position + cursor - insertion.end : cursor
          textarea.setSelectionRange(
            unchangedSelection ? cursor : mapPosition(selection.start),
            unchangedSelection ? cursor : mapPosition(selection.end), selection.direction,
          )
        }
        if (result.rejected.length) {
          showToastNotification({ variant: "warning", title: tGlobal("promptInput.attachFiles.skipped.title"),
            message: result.rejected.map(({ name, reason }) => tGlobal(`promptInput.attachFiles.rejected.${reason}`, { name })).join("\n") })
        }
      } finally {
        if (owner.current()) {
          setPending(value => Math.max(0, value - 1))
        }
      }
    }
    const request = tail.then(run)
    tail = request.catch(() => {})
    return request
  }

  function handleUploadFiles() {
    if (!available() || pending() || picker) return
    const owner = capture()
    // A fresh shared HTML input per gesture binds even picker-open transitions
    // and permits reselecting the same file. All hosts use their native picker.
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.hidden = true
    input.setAttribute("aria-label", tGlobal("promptInput.attachFiles.title"))
    picker = input
    document.body.append(input)
    const close = () => { input.remove(); if (picker === input) picker = undefined }
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? [])
      close()
      if (!owner.current()) return
      focus(owner)
      if (files.length) void enqueue(files, false, owner)
    }, { once: true })
    input.addEventListener("cancel", () => { close(); focus(owner) }, { once: true })
    try { input.click() } catch { close(); focus(owner) }
  }

  return { handleUploadFiles, enqueue, isReadingFiles: () => pending() > 0, capture, focus }
}

// Use the paste gesture's selection, never a later one. Map an unchanged anchor
// around edits before/after it; if an edit overlaps it, append without deleting
// any new text. This also preserves earlier tokens from queued clipboard batches.
function clipboardInsertion(anchor: { text: string; start: number; end: number }, text: string) {
  if (text === anchor.text) return anchor
  let prefix = 0, suffix = 0
  while (prefix < text.length && prefix < anchor.text.length && text[prefix] === anchor.text[prefix]) prefix++
  while (suffix < text.length - prefix && suffix < anchor.text.length - prefix
    && text[text.length - suffix - 1] === anchor.text[anchor.text.length - suffix - 1]) suffix++
  const start = anchor.start < prefix ? anchor.start
    : anchor.start > anchor.text.length - suffix ? anchor.start + text.length - anchor.text.length : text.length
  return { start, end: start }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
