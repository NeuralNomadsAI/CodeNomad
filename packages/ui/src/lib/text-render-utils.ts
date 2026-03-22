const extensionToLanguage: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "bash",
  bash: "bash",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  rs: "rust",
  go: "go",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "cpp",
  c: "c",
  java: "java",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
}

export function getLanguageFromPath(path?: string | null): string | undefined {
  if (!path) return undefined
  const ext = path.split(".").pop()?.toLowerCase()
  return ext ? extensionToLanguage[ext] : undefined
}

export function decodeHtmlEntities(content: string): string {
  if (!content.includes("&")) {
    return content
  }

  const entityPattern = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  }

  let result = content
  let previous = ""

  while (result.includes("&") && result !== previous) {
    previous = result
    result = result.replace(entityPattern, (match, entity) => {
      if (!entity) {
        return match
      }

      if (entity[0] === "#") {
        const isHex = entity[1]?.toLowerCase() === "x"
        const value = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
        if (!Number.isNaN(value)) {
          try {
            return String.fromCodePoint(value)
          } catch {
            return match
          }
        }
        return match
      }

      const decoded = namedEntities[entity.toLowerCase()]
      return decoded !== undefined ? decoded : match
    })
  }

  return result
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    '"': "&quot;",
    "'": "&#039;",
  }
  return text.replace(/[&<"']/g, (match) => map[match])
}
