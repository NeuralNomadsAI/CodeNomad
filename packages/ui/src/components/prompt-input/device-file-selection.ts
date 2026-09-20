import { PROMPT_INLINE_FILE_LIMITS } from "../../../../server/src/api-types"
import type { Attachment } from "../../types/attachment"

export interface InlineFileUsage {
  count: number
  bytes: number
}

export interface ReadDeviceFile {
  file: File
  data: Uint8Array
}

export interface DeviceFileSelectionResult {
  files: ReadDeviceFile[]
  tooLargeCount: number
  overBudgetCount: number
  unreadableCount: number
  stale: boolean
}

type ReadFileBytes = (file: File) => Promise<Uint8Array>

export function getInlineFileUsage(attachments: readonly Attachment[]): InlineFileUsage {
  let count = 0
  let bytes = 0
  for (const attachment of attachments) {
    if (attachment.source.type !== "file" || !/^data:/i.test(attachment.url)) continue
    count += 1
    bytes += decodedDataUriSize(attachment.url)
      ?? attachment.source.data?.byteLength
      ?? PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
  }
  return { count, bytes }
}

export async function readDeviceFileSelection(
  input: FileList | readonly File[],
  existingAttachments: readonly Attachment[],
  isCurrent: () => boolean,
  readFileBytes: ReadFileBytes = defaultReadFileBytes,
): Promise<DeviceFileSelectionResult> {
  const usage = getInlineFileUsage(existingAttachments)
  const accepted: File[] = []
  let plannedCount = usage.count
  let plannedBytes = usage.bytes
  let tooLargeCount = 0
  let overBudgetCount = 0

  for (const file of Array.from(input)) {
    if (file.size > PROMPT_INLINE_FILE_LIMITS.maxFileBytes) {
      tooLargeCount += 1
      continue
    }
    if (
      plannedCount + 1 > PROMPT_INLINE_FILE_LIMITS.maxFiles
      || plannedBytes + file.size > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
    ) {
      overBudgetCount += 1
      continue
    }
    accepted.push(file)
    plannedCount += 1
    plannedBytes += file.size
  }

  const files: ReadDeviceFile[] = []
  let actualCount = usage.count
  let actualBytes = usage.bytes
  let unreadableCount = 0
  for (const file of accepted) {
    if (!isCurrent()) return { files: [], tooLargeCount, overBudgetCount, unreadableCount, stale: true }
    try {
      const data = await readFileBytes(file)
      if (!isCurrent()) return { files: [], tooLargeCount, overBudgetCount, unreadableCount, stale: true }
      if (data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxFileBytes) {
        tooLargeCount += 1
      } else if (
        actualCount + 1 > PROMPT_INLINE_FILE_LIMITS.maxFiles
        || actualBytes + data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
      ) {
        overBudgetCount += 1
      } else {
        files.push({ file, data })
        actualCount += 1
        actualBytes += data.byteLength
      }
    } catch {
      if (!isCurrent()) return { files: [], tooLargeCount, overBudgetCount, unreadableCount, stale: true }
      unreadableCount += 1
    }
  }

  return { files, tooLargeCount, overBudgetCount, unreadableCount, stale: false }
}

async function defaultReadFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

function decodedDataUriSize(uri: string): number | null {
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const metadata = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
    if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
    return (payload.length / 4) * 3 - padding
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength
  } catch {
    return null
  }
}
