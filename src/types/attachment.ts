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
    id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
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

export function createAgentAttachment(agentName: string): Attachment {
  return {
    id: crypto.randomUUID(),
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
