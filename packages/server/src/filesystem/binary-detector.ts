/**
 * Binary File Detector
 *
 * Detects whether a file is binary using magic bytes and content analysis.
 * Binary files cannot be auto-merged and require manual conflict resolution.
 */

import * as path from "path"

/**
 * Magic byte signatures for common binary file formats
 * Each entry maps file type to its magic bytes at offset 0
 */
const MAGIC_BYTES: Record<string, { bytes: number[]; offset?: number }> = {
  // Images
  png: { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  jpg: { bytes: [0xff, 0xd8, 0xff] },
  gif: { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  webp: { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF (WebP starts with RIFF...WEBP)
  bmp: { bytes: [0x42, 0x4d] }, // BM
  ico: { bytes: [0x00, 0x00, 0x01, 0x00] },
  tiff_le: { bytes: [0x49, 0x49, 0x2a, 0x00] }, // Little-endian TIFF
  tiff_be: { bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // Big-endian TIFF
  psd: { bytes: [0x38, 0x42, 0x50, 0x53] }, // 8BPS

  // Documents
  pdf: { bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  docx: { bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK (ZIP-based)
  xlsx: { bytes: [0x50, 0x4b, 0x03, 0x04] },
  pptx: { bytes: [0x50, 0x4b, 0x03, 0x04] },
  doc: { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // OLE
  xls: { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },

  // Archives
  zip: { bytes: [0x50, 0x4b, 0x03, 0x04] },
  zip_empty: { bytes: [0x50, 0x4b, 0x05, 0x06] },
  zip_spanned: { bytes: [0x50, 0x4b, 0x07, 0x08] },
  rar: { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // Rar!
  "7z": { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // 7z
  gz: { bytes: [0x1f, 0x8b] },
  bz2: { bytes: [0x42, 0x5a, 0x68] }, // BZh
  xz: { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  tar: { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257 }, // ustar at 257

  // Executables
  elf: { bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  macho_32: { bytes: [0xfe, 0xed, 0xfa, 0xce] }, // Mach-O 32-bit
  macho_64: { bytes: [0xfe, 0xed, 0xfa, 0xcf] }, // Mach-O 64-bit
  macho_32_le: { bytes: [0xce, 0xfa, 0xed, 0xfe] }, // Mach-O 32-bit LE
  macho_64_le: { bytes: [0xcf, 0xfa, 0xed, 0xfe] }, // Mach-O 64-bit LE
  macho_fat: { bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Mach-O fat binary
  pe: { bytes: [0x4d, 0x5a] }, // MZ (PE/COFF)
  wasm: { bytes: [0x00, 0x61, 0x73, 0x6d] }, // \0asm

  // Audio
  mp3_id3: { bytes: [0x49, 0x44, 0x33] }, // ID3
  mp3: { bytes: [0xff, 0xfb] },
  wav: { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  ogg: { bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  flac: { bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  m4a: { bytes: [0x00, 0x00, 0x00], offset: 0 }, // Starts with size, then ftyp

  // Video
  mp4: { bytes: [0x00, 0x00, 0x00], offset: 0 }, // Similar to m4a
  webm: { bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // EBML
  mkv: { bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  avi: { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF

  // Fonts
  woff: { bytes: [0x77, 0x4f, 0x46, 0x46] }, // wOFF
  woff2: { bytes: [0x77, 0x4f, 0x46, 0x32] }, // wOF2
  ttf: { bytes: [0x00, 0x01, 0x00, 0x00] },
  otf: { bytes: [0x4f, 0x54, 0x54, 0x4f] }, // OTTO

  // Databases
  sqlite: { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74] }, // SQLite format

  // Other
  class: { bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Java class (same as Mach-O fat)
}

/**
 * File extensions that are always considered binary
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".psd",
  ".heic",
  ".heif",
  ".avif",
  ".raw",
  ".cr2",
  ".nef",
  ".arw",

  // Documents
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",

  // Archives
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".lz",
  ".lzma",
  ".cab",
  ".dmg",
  ".iso",

  // Executables
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".app",
  ".deb",
  ".rpm",
  ".msi",
  ".apk",
  ".ipa",
  ".wasm",

  // Audio
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".aiff",
  ".opus",

  // Video
  ".mp4",
  ".webm",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".m4v",
  ".mpeg",
  ".mpg",

  // Fonts
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",

  // Databases
  ".sqlite",
  ".sqlite3",
  ".db",

  // Other
  ".class",
  ".o",
  ".obj",
  ".pyc",
  ".pyo",
  ".beam",
  ".jar",
  ".war",
  ".ear",
])

/**
 * File extensions that are always considered text
 */
const TEXT_EXTENSIONS = new Set([
  // Code
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".json5",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".swift",
  ".m",
  ".mm",
  ".r",
  ".R",
  ".jl",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".hs",
  ".lhs",
  ".elm",
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  ".lisp",
  ".cl",
  ".el",
  ".scm",
  ".rkt",
  ".ml",
  ".mli",
  ".f",
  ".f90",
  ".f95",
  ".cob",
  ".cbl",
  ".asm",
  ".s",
  ".S",
  ".v",
  ".sv",
  ".vh",
  ".svh",
  ".vhd",
  ".vhdl",

  // Web
  ".html",
  ".htm",
  ".xhtml",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".vue",
  ".svelte",
  ".astro",

  // Config
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".config",
  ".env",
  ".properties",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  ".babelrc",

  // Markup/Data
  ".xml",
  ".xsl",
  ".xslt",
  ".xsd",
  ".dtd",
  ".svg",
  ".md",
  ".markdown",
  ".mdx",
  ".rst",
  ".txt",
  ".text",
  ".log",
  ".csv",
  ".tsv",

  // Shell
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",

  // Build/Make
  ".mk",
  ".make",
  ".cmake",
  ".gradle",
  ".sbt",

  // Other
  ".lock",
  ".diff",
  ".patch",
  ".graphql",
  ".gql",
  ".proto",
  ".sql",
])

export interface BinaryDetectionResult {
  isBinary: boolean
  confidence: "high" | "medium" | "low"
  reason: string
  detectedType?: string
}

/**
 * Check if a buffer starts with the given magic bytes
 */
function matchesMagicBytes(
  buffer: Buffer,
  signature: { bytes: number[]; offset?: number }
): boolean {
  const offset = signature.offset ?? 0
  if (buffer.length < offset + signature.bytes.length) {
    return false
  }

  for (let i = 0; i < signature.bytes.length; i++) {
    if (buffer[offset + i] !== signature.bytes[i]) {
      return false
    }
  }
  return true
}

/**
 * Check buffer for null bytes (common binary indicator)
 */
function hasNullBytes(buffer: Buffer, maxCheck: number = 8192): boolean {
  const checkLength = Math.min(buffer.length, maxCheck)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

/**
 * Calculate the ratio of non-printable characters
 */
function getNonPrintableRatio(buffer: Buffer, maxCheck: number = 8192): number {
  const checkLength = Math.min(buffer.length, maxCheck)
  let nonPrintable = 0

  for (let i = 0; i < checkLength; i++) {
    const byte = buffer[i]
    // Consider bytes outside printable ASCII + common control chars as non-printable
    // Printable: 0x20-0x7E, Tab: 0x09, LF: 0x0A, CR: 0x0D
    if (
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0d &&
      (byte < 0x20 || byte > 0x7e)
    ) {
      // Allow UTF-8 continuation bytes (0x80-0xBF) and leading bytes (0xC0-0xF7)
      if (byte < 0x80 || byte > 0xf7) {
        nonPrintable++
      }
    }
  }

  return nonPrintable / checkLength
}

/**
 * Detect if content is binary
 *
 * @param content - File content as Buffer or string
 * @param filePath - Optional file path for extension-based detection
 * @returns Detection result with confidence level
 */
export function isBinaryFile(
  content: Buffer | string,
  filePath?: string
): BinaryDetectionResult {
  const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content

  // Check extension first (fastest)
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase()

    if (BINARY_EXTENSIONS.has(ext)) {
      return {
        isBinary: true,
        confidence: "high",
        reason: `Binary file extension: ${ext}`,
        detectedType: ext.slice(1),
      }
    }

    if (TEXT_EXTENSIONS.has(ext)) {
      return {
        isBinary: false,
        confidence: "high",
        reason: `Text file extension: ${ext}`,
        detectedType: ext.slice(1),
      }
    }
  }

  // Check magic bytes
  for (const [type, signature] of Object.entries(MAGIC_BYTES)) {
    if (matchesMagicBytes(buffer, signature)) {
      return {
        isBinary: true,
        confidence: "high",
        reason: `Magic bytes match: ${type}`,
        detectedType: type,
      }
    }
  }

  // Check for null bytes (strong binary indicator)
  if (hasNullBytes(buffer)) {
    return {
      isBinary: true,
      confidence: "high",
      reason: "Contains null bytes",
    }
  }

  // Check non-printable character ratio
  const ratio = getNonPrintableRatio(buffer)
  if (ratio > 0.3) {
    return {
      isBinary: true,
      confidence: "medium",
      reason: `High non-printable ratio: ${(ratio * 100).toFixed(1)}%`,
    }
  }

  if (ratio > 0.1) {
    return {
      isBinary: true,
      confidence: "low",
      reason: `Moderate non-printable ratio: ${(ratio * 100).toFixed(1)}%`,
    }
  }

  // Assume text if no binary indicators found
  return {
    isBinary: false,
    confidence: ratio > 0.01 ? "medium" : "high",
    reason: ratio > 0.01
      ? `Low non-printable ratio: ${(ratio * 100).toFixed(1)}%`
      : "No binary indicators found",
  }
}

/**
 * Quick binary check for a file path based on extension only
 */
export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * Quick text check for a file path based on extension only
 */
export function isTextExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

/**
 * Get the set of known binary extensions
 */
export function getBinaryExtensions(): Set<string> {
  return new Set(BINARY_EXTENSIONS)
}

/**
 * Get the set of known text extensions
 */
export function getTextExtensions(): Set<string> {
  return new Set(TEXT_EXTENSIONS)
}
