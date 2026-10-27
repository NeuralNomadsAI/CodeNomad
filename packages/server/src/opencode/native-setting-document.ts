import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind } from "jsonc-parser"
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

/** Removes `keys` when it holds an object without properties, keeping comments written inside it
 * where the property was. Any other value is left alone; returns undefined when nothing changes. */
export function removeEmptyNativeObject(document: PluginControlDocument, keys: string[]): string | undefined {
  const value = readNativeSetting(document, keys)
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) return undefined
  const node = findNodeAtLocation(parseTree(document.text, [], { allowTrailingComma: true })!, keys)!
  const scanner = createScanner(document.text.slice(node.offset, node.offset + node.length))
  const comments: string[] = []
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) comments.push(scanner.getTokenValue())
  }
  const removed = editNativeSetting(document, keys, undefined)
  if (!comments.length) return removed
  // The removal starts at the same offset in the edited text, after the byte order mark.
  const offset = modify(document.text, keys, undefined, {})[0].offset + (document.byteOrderMark ? 1 : 0)
  const eol = removed.includes("\r\n") ? "\r\n" : "\n"
  const lineIndent = /[ \t]*$/.exec(removed.slice(0, offset))?.[0] ?? ""
  const block = comments.join(`${eol}${lineIndent}`)
  // Before a following property, the comments take its line; after the last one they trail its value.
  const insert = /^\s*[}\]]/.test(removed.slice(offset)) ? ` ${block}${eol}` : `${block}${eol}${lineIndent}`
  return removed.slice(0, offset) + insert + removed.slice(offset)
}
