const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdx"])
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp", ".tiff", ".tif"])
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"])
const VIDEO_EXTS = new Set([".mp4", ".webm", ".ogg", ".ogv", ".mov", ".avi", ".mkv", ".m4v"])
const PDF_EXTS = new Set([".pdf"])

function getExt(path: string): string {
  const idx = path.lastIndexOf(".")
  return idx >= 0 ? path.slice(idx).toLowerCase() : ""
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTS.has(getExt(path))
}

export function isImage(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path))
}

export function isAudio(path: string): boolean {
  return AUDIO_EXTS.has(getExt(path))
}

export function isVideo(path: string): boolean {
  return VIDEO_EXTS.has(getExt(path))
}

export function isPDF(path: string): boolean {
  return PDF_EXTS.has(getExt(path))
}

export function isBinaryFile(path: string): boolean {
  return isImage(path) || isAudio(path) || isVideo(path) || isPDF(path)
}

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".wma": "audio/x-ms-wma",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".m4v": "video/mp4",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".md": "text/markdown",
  ".txt": "text/plain",
}

export function inferMimeType(path: string): string {
  return MIME_MAP[getExt(path)] || "application/octet-stream"
}
