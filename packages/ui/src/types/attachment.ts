export interface Attachment {
  id: string
  type: AttachmentType
  display: string
  url: string
  filename: string
  mediaType: string
  source: AttachmentSource
}

export type AttachmentType = "file" | "text" | "symbol" | "agent"

export type AttachmentSource = FileSource | TextSource | SymbolSource | AgentSource

export interface FileSource {
  type: "file"
  path: string
  mime: string
  data?: Uint8Array
}

export interface TextSource {
  type: "text"
  value: string
}

export interface SymbolSource {
  type: "symbol"
  path: string
  name: string
  kind: number
  range: SymbolRange
}

export interface SymbolRange {
  start: Position
  end: Position
}

export interface Position {
  line: number
  char: number
}

export interface AgentSource {
  type: "agent"
  name: string
}

// Generate UUID with fallback for browsers without crypto.randomUUID
function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback: generate a simple UUID v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function createFileAttachment(
  path: string,
  filename: string,
  mime: string = "text/plain",
  data?: Uint8Array,
  workspaceRoot?: string,
): Attachment {
  let fileUrl = path
  if (workspaceRoot && !path.startsWith("file://")) {
    const absolutePath = path.startsWith("/") ? path : `${workspaceRoot}/${path}`
    fileUrl = `file://${absolutePath}`
  } else if (!path.startsWith("file://") && path.startsWith("/")) {
    fileUrl = `file://${path}`
  }

  return {
    id: generateUUID(),
    type: "file",
    display: `@${filename}`,
    url: fileUrl,
    filename,
    mediaType: mime,
    source: {
      type: "file",
      path: path,
      mime,
      data,
    },
  }
}

export function createTextAttachment(value: string, display: string, filename: string): Attachment {
  const base64 = encodeTextAsBase64(value)
  return {
    id: generateUUID(),
    type: "text",
    display,
    url: `data:text/plain;base64,${base64}`,
    filename,
    mediaType: "text/plain",
    source: {
      type: "text",
      value,
    },
  }
}

function encodeTextAsBase64(value: string): string {
  if (typeof TextEncoder !== "undefined") {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(value)
    let binary = ""
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length))
      binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
  }

  return btoa(
    encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
  )
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
}

export function symbolKindLabel(kind: number): string {
  return SYMBOL_KIND_LABELS[kind] ?? "symbol"
}

export function createSymbolAttachment(
  symbolName: string,
  filePath: string,
  kind: number,
  range: SymbolRange,
  workspaceRoot?: string,
): Attachment {
  const filename = filePath.split("/").pop() || filePath
  const display = `@${symbolName} (${filename}:${range.start.line + 1})`

  let fileUrl = filePath
  if (workspaceRoot && !filePath.startsWith("file://")) {
    const absolutePath = filePath.startsWith("/") ? filePath : `${workspaceRoot}/${filePath}`
    fileUrl = `file://${absolutePath}#L${range.start.line + 1}`
  } else if (!filePath.startsWith("file://") && filePath.startsWith("/")) {
    fileUrl = `file://${filePath}#L${range.start.line + 1}`
  }

  return {
    id: generateUUID(),
    type: "symbol",
    display,
    url: fileUrl,
    filename: symbolName,
    mediaType: "text/plain",
    source: {
      type: "symbol",
      path: filePath,
      name: symbolName,
      kind,
      range,
    },
  }
}

export function createAgentAttachment(agentName: string): Attachment {
  return {
    id: generateUUID(),
    type: "agent",
    display: `@${agentName}`,
    url: "",
    filename: agentName,
    mediaType: "text/plain",
    source: {
      type: "agent",
      name: agentName,
    },
  }
}
