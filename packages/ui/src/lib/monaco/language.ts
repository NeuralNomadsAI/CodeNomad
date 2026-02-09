type MonacoApi = any

let cachedLanguageMaps:
  | {
      fileNameToId: Map<string, string>
      extToId: Map<string, string>
    }
  | null = null

function buildLanguageMaps(monaco: MonacoApi) {
  if (cachedLanguageMaps) return cachedLanguageMaps

  const fileNameToId = new Map<string, string>()
  const extToId = new Map<string, string>()

  const languages = typeof monaco?.languages?.getLanguages === "function" ? monaco.languages.getLanguages() : []
  if (Array.isArray(languages)) {
    for (const lang of languages) {
      const id = typeof lang?.id === "string" ? lang.id : null
      if (!id) continue

      const filenames = Array.isArray(lang?.filenames) ? lang.filenames : []
      for (const name of filenames) {
        if (typeof name !== "string") continue
        if (!fileNameToId.has(name)) fileNameToId.set(name, id)
      }

      const extensions = Array.isArray(lang?.extensions) ? lang.extensions : []
      for (const ext of extensions) {
        if (typeof ext !== "string") continue
        // Monaco uses leading dots for extensions (e.g. ".ts").
        if (!extToId.has(ext)) extToId.set(ext, id)
      }
    }
  }

  cachedLanguageMaps = { fileNameToId, extToId }
  return cachedLanguageMaps
}

function overrideLanguageId(fileName: string): string | null {
  // Git-style ignore/config files: treat as shell-like.
  if (fileName === ".gitignore" || fileName === ".gitattributes" || fileName === ".gitmodules") return "shell"

  // Monaco doesn't ship a dedicated Makefile tokenizer in our baseline.
  if (fileName === "Makefile" || fileName.startsWith("Makefile.")) return "shell"

  return null
}

export function inferMonacoLanguageId(monaco: MonacoApi, path: string | undefined | null): string {
  const raw = String(path || "").trim()
  const fileName = raw.split("/").pop() || raw

  const override = overrideLanguageId(fileName)
  if (override) return override

  const maps = buildLanguageMaps(monaco)
  const byName = maps.fileNameToId.get(fileName)
  if (byName) return byName

  const dot = fileName.lastIndexOf(".")
  if (dot > 0) {
    const ext = fileName.slice(dot)
    const byExt = maps.extToId.get(ext)
    if (byExt) return byExt
  }

  return "plaintext"
}
