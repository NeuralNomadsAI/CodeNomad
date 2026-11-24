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
  rejected: { name: string; reason: "tooLarge" | "limit" | "unreadable" }[]
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
  const files: ReadDeviceFile[] = []
  let actualCount = usage.count
  let actualBytes = usage.bytes
  let tooLargeCount = 0
  let overBudgetCount = 0
  const rejected: DeviceFileSelectionResult["rejected"] = []
  let unreadableCount = 0

  for (const file of Array.from(input)) {
    if (!isCurrent()) return { files: [], rejected, tooLargeCount, overBudgetCount, unreadableCount, stale: true }
    if (file.size > PROMPT_INLINE_FILE_LIMITS.maxFileBytes) {
      tooLargeCount += 1
      rejected.push({ name: file.name, reason: "tooLarge" })
      continue
    }
    if (
      actualCount + 1 > PROMPT_INLINE_FILE_LIMITS.maxFiles
      || actualBytes + file.size > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
    ) {
      overBudgetCount += 1
      rejected.push({ name: file.name, reason: "limit" })
      continue
    }
    try {
      const data = await readFileBytes(file)
      if (!isCurrent()) return { files: [], rejected, tooLargeCount, overBudgetCount, unreadableCount, stale: true }
      if (data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxFileBytes) {
        tooLargeCount += 1
        rejected.push({ name: file.name, reason: "tooLarge" })
      } else if (
        actualCount + 1 > PROMPT_INLINE_FILE_LIMITS.maxFiles
        || actualBytes + data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
      ) {
        overBudgetCount += 1
        rejected.push({ name: file.name, reason: "limit" })
      } else {
        files.push({ file, data })
        actualCount += 1
        actualBytes += data.byteLength
      }
    } catch {
      if (!isCurrent()) return { files: [], rejected, tooLargeCount, overBudgetCount, unreadableCount, stale: true }
      unreadableCount += 1
      rejected.push({ name: file.name, reason: "unreadable" })
    }
  }

  return { files, rejected, tooLargeCount, overBudgetCount, unreadableCount, stale: false }
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
