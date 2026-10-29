import { isDeepStrictEqual } from "node:util"
import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind, type ParseError } from "jsonc-parser"
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


const trivia = new Set([SyntaxKind.Trivia, SyntaxKind.LineBreakTrivia, SyntaxKind.LineCommentTrivia, SyntaxKind.BlockCommentTrivia])
const isComment = (kind: SyntaxKind) => kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia

/** The first non-trivia token at or after `offset`. */
function nextToken(text: string, offset: number) {
  const scanner = createScanner(text, false)
  scanner.setPosition(offset)
  let kind = scanner.scan()
  while (trivia.has(kind)) kind = scanner.scan()
  return { kind, offset: scanner.getTokenOffset() }
}

function withoutKey(value: unknown, keys: string[]): unknown {
  const copy = structuredClone(value) as Record<string, any>
  let parent = copy
  for (const key of keys.slice(0, -1)) parent = parent[key]
  delete parent[keys.at(-1)!]
  return copy
}

/** Removes `keys` when it holds an object without properties, in one edit of the original source:
 * the property and one adjacent comma go, and comments written inside the object stay in its place
 * (line comments become block comments, so they can share the line). The result must parse without
 * errors to the original value minus that key; otherwise nothing is returned, like for any other value. */
export function removeEmptyNativeObject(document: PluginControlDocument, keys: string[]): string | undefined {
  const value = readNativeSetting(document, keys)
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) return undefined
  const text = document.text
  const root = parseTree(text, [], { allowTrailingComma: true })!
  const parent = keys.length > 1 ? findNodeAtLocation(root, keys.slice(0, -1))! : root
  const properties = parent.children ?? []
  const index = properties.findIndex(child => child.children?.[0]?.value === keys.at(-1))
  const property = properties[index], node = property.children![1]
  const scanner = createScanner(text, false), comments: string[] = []
  scanner.setPosition(node.offset)
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF && scanner.getTokenOffset() < node.offset + node.length; kind = scanner.scan()) {
    if (!isComment(kind)) continue
    const source = text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength())
    comments.push(kind === SyntaxKind.LineCommentTrivia ? `/*${source.slice(2).replace(/\*\//g, "* /")} */` : source)
  }
  const edits = [{ offset: property.offset, length: property.length, content: comments.join(" ") }]
  const following = nextToken(text, property.offset + property.length)
  const previous = index > 0 ? nextToken(text, properties[index - 1].offset + properties[index - 1].length) : undefined
  if (following.kind === SyntaxKind.CommaToken) edits.push({ offset: following.offset, length: 1, content: "" })
  else if (previous?.kind === SyntaxKind.CommaToken) edits.push({ offset: previous.offset, length: 1, content: "" })
  const updated = applyEdits(text, edits)
  const errors: ParseError[] = []
  const result = parse(updated, errors, { allowTrailingComma: true })
  if (errors.length || !isDeepStrictEqual(result, withoutKey(parse(text, [], { allowTrailingComma: true }), keys))) return undefined
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return `${document.byteOrderMark ? String.fromCharCode(0xfeff) : ""}${updated}${updated.endsWith("\n") ? "" : eol}`
}
