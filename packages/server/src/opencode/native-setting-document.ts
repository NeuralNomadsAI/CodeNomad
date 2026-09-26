import { applyEdits, modify, parse, parseTree } from "jsonc-parser"
import { PluginControlDocumentError, type PluginControlDocument } from "./plugin-control-document"

// Restrict callers to one known setting path, retaining comments and foreign
// properties. Duplicate keys along the edited path are ambiguous and fail closed.
export function readNativeSetting(document: PluginControlDocument, keys: string[]): unknown {
  let node = parseTree(document.text, [], { allowTrailingComma: true })
  for (const key of keys) {
    if (!node) return undefined
    if (node.type !== "object") throw new PluginControlDocumentError("OpenCode setting parent must be an object", "invalid")
    const matches = node.children?.filter(child => child.children?.[0]?.value === key) ?? []
    if (matches.length > 1) throw new PluginControlDocumentError("OpenCode setting has duplicate keys", "invalid")
    node = matches[0]?.children?.[1]
  }
  return node ? parse(document.text.slice(node.offset, node.offset + node.length)) : undefined
}

export function editNativeSetting(document: PluginControlDocument, keys: string[], value: unknown): string {
  readNativeSetting(document, keys)
  const eol = document.text.includes("\r\n") ? "\r\n" : "\n"
  const indent = /^([ \t]+)\S/m.exec(document.text)?.[1] ?? "  "
  const updated = applyEdits(document.text, modify(document.text, keys, value, {
    formattingOptions: { eol, insertSpaces: !indent.includes("\t"), tabSize: indent.length },
  }))
  return `${document.byteOrderMark ? "\uFEFF" : ""}${updated}${updated.endsWith("\n") ? "" : eol}`
}
