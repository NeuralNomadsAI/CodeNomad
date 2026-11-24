import { isDeepStrictEqual } from "node:util"
import {
  applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind, type Node as JsonNode, type ParseError,
} from "jsonc-parser"
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

/** Appends `value` to the list at `keys`, creating the list and its missing parent objects. The element
 * follows the last one on its own line at its indentation (or beside it), keeping a trailing comma, so
 * existing lines stay untouched; `comment` becomes the first line inside an object element. */
export function appendNativeSetting(document: PluginControlDocument, keys: string[], value: unknown, comment?: string): string {
  return appendMember(document, keys, value, comment)
}

/** `appendNativeSetting` for a new property `name` of the object at `keys`, which must not have it yet. */
export function appendNativeProperty(document: PluginControlDocument, keys: string[], name: string, value: unknown,
  comment?: string): string {
  return appendMember(document, keys, value, comment, name)
}

function appendMember(document: PluginControlDocument, keys: string[], value: unknown, comment?: string, name?: string): string {
  const container = readNativeSetting(document, keys)
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  if (container !== undefined && (name === undefined ? !Array.isArray(container) : !object(container)))
    throw new PluginControlDocumentError(`OpenCode setting must be ${name === undefined ? "a list" : "an object"}`, "invalid")
  if (container === undefined)
    return appendMember(withEditedText(document, editNativeSetting(document, keys, name === undefined ? [] : {})), keys, value, comment, name)
  if (name !== undefined && Object.prototype.hasOwnProperty.call(container, name)) throw new PluginControlDocumentError("OpenCode setting already exists", "invalid")
  const text = document.text, eol = text.includes("\r\n") ? "\r\n" : "\n", unit = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  "
  const lineStart = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1
  const indentation = (offset: number) => /^[ \t]*/.exec(text.slice(lineStart(offset)))![0]
  const render = (base: string) => {
    const lines = JSON.stringify(value, null, unit).split("\n")
    if (comment !== undefined && lines.length > 2 && lines[0] === "{") lines.splice(1, 0, `${unit}// ${comment}`)
    const member = lines.map((line, index) => index ? base + line : line).join(eol)
    return name === undefined ? member : `${JSON.stringify(name)}: ${member}`
  }
  const node = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true })!, keys)!
  const last = node.children?.at(-1)
  let edits: { offset: number; length: number; content: string }[]
  if (last) {
    const base = indentation(last.offset), end = last.offset + last.length
    const following = nextToken(text, end), trailing = following.kind === SyntaxKind.CommaToken
    const after = trailing ? following.offset + 1 : end
    // An element alone on its line is followed by a new line after any comment ending that line.
    const at = text.slice(lineStart(last.offset), last.offset) === base ? lineBreak(text, after) : undefined
    const element = `${render(base)}${trailing ? "," : ""}`
    edits = at === undefined ? [{ offset: after, length: 0, content: `${trailing ? "" : ","} ${element}` }]
      : [...trailing ? [] : [{ offset: end, length: 0, content: "," }], { offset: at, length: 0, content: `${eol}${base}${element}` }]
  } else {
    const base = indentation(node.offset)
    edits = [{ offset: node.offset + 1, length: 0, content: `${eol}${base}${unit}${render(base + unit)}${eol}${base}` }]
  }
  const updated = applyEdits(text, edits)
  const errors: ParseError[] = []
  const expected = parse(text, [], { allowTrailingComma: true }), target = keys.reduce((parent, key) => parent[key], expected)
  if (name === undefined) target.push(value)
  else target[name] = value
  if (!isDeepStrictEqual(parse(updated, errors, { allowTrailingComma: true }), expected) || errors.length)
    throw new PluginControlDocumentError("OpenCode setting could not be appended", "invalid")
  return `${document.byteOrderMark ? String.fromCharCode(0xfeff) : ""}${updated}${updated.endsWith("\n") ? "" : eol}`
}

/** The document holding `text`, a full edit result (byte order mark included), for a chained edit. */
export function withEditedText(document: PluginControlDocument, text: string): PluginControlDocument {
  return { ...document, text: document.byteOrderMark && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }
}

const trivia = new Set([SyntaxKind.Trivia, SyntaxKind.LineBreakTrivia, SyntaxKind.LineCommentTrivia, SyntaxKind.BlockCommentTrivia])
const isComment = (kind: SyntaxKind) => kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia

/** The offset of the line break ending the line at `offset` when only whitespace and comments precede it. */
function lineBreak(text: string, offset: number): number | undefined {
  const scanner = createScanner(text, false)
  scanner.setPosition(offset)
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF && trivia.has(kind); kind = scanner.scan())
    if (kind === SyntaxKind.LineBreakTrivia) return scanner.getTokenOffset()
  return undefined
}

/** The first non-trivia token at or after `offset`. */
function nextToken(text: string, offset: number) {
  const scanner = createScanner(text, false)
  scanner.setPosition(offset)
  let kind = scanner.scan()
  while (trivia.has(kind)) kind = scanner.scan()
  return { kind, offset: scanner.getTokenOffset() }
}

/** `value` without the member at `path`: an object key, or a list index when the last segment is a number. */
function without(value: unknown, path: (string | number)[]): unknown {
  const copy = structuredClone(value) as any
  let parent = copy
  for (const key of path.slice(0, -1)) parent = parent[key]
  const last = path.at(-1)!
  if (typeof last === "number") parent.splice(last, 1)
  else delete parent[last]
  return copy
}

/** The edited text when it parses without errors to the original value minus `path`, else `undefined`. */
function removal(document: PluginControlDocument, edits: { offset: number; length: number; content: string }[],
  path: (string | number)[]): string | undefined {
  const text = document.text
  const updated = applyEdits(text, edits)
  const errors: ParseError[] = []
  const result = parse(updated, errors, { allowTrailingComma: true })
  if (errors.length || !isDeepStrictEqual(result, without(parse(text, [], { allowTrailingComma: true }), path))) return undefined
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return `${document.byteOrderMark ? String.fromCharCode(0xfeff) : ""}${updated}${updated.endsWith("\n") ? "" : eol}`
}

/** Removes `keys` when it holds an object without properties (or whose properties `removable` accepts),
 * in one edit of the original source: the property and one adjacent comma go, and comments written inside
 * the object stay in its place (line comments become block comments, so they can share the line); a property
 * alone on its line without such comments takes the line with it. The
 * result must parse without errors to the original value minus that key; otherwise nothing is returned,
 * like for any other value. */
export function removeEmptyNativeObject(document: PluginControlDocument, keys: string[],
  removable: (value: Record<string, unknown>) => boolean = value => Object.keys(value).length === 0): string | undefined {
  return removeNativeContainer(document, keys, value => Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && removable(value as Record<string, unknown>))
}

/** `removeEmptyNativeObject` for a list without elements. */
export function removeEmptyNativeList(document: PluginControlDocument, keys: string[]): string | undefined {
  return removeNativeContainer(document, keys, value => Array.isArray(value) && value.length === 0)
}

/** Removes the element at `index` of the list at `keys` with one adjacent comma, and its line when the
 * element stood alone on it; comments outside the element stay. The same parse check applies. */
export function removeNativeListElement(document: PluginControlDocument, keys: string[], index: number): string | undefined {
  const list = readNativeSetting(document, keys)
  if (!Array.isArray(list) || !Number.isSafeInteger(index) || index < 0 || index >= list.length) return undefined
  const elements = findNodeAtLocation(parseTree(document.text, [], { allowTrailingComma: true })!, keys)!.children!
  return removeMember(document, elements, index, [...keys, index])
}

/** `removeNativeListElement` for the property at `keys`, comments inside its value included. */
export function removeNativeProperty(document: PluginControlDocument, keys: string[]): string | undefined {
  if (readNativeSetting(document, keys) === undefined) return undefined
  const root = parseTree(document.text, [], { allowTrailingComma: true })!
  const properties = (keys.length > 1 ? findNodeAtLocation(root, keys.slice(0, -1))! : root).children ?? []
  return removeMember(document, properties, properties.findIndex(child => child.children?.[0]?.value === keys.at(-1)), keys)
}

/** Removes `members[index]` (a list element or an object property) with one adjacent comma. */
function removeMember(document: PluginControlDocument, members: JsonNode[], index: number, path: (string | number)[]) {
  const text = document.text, member = members[index], end = member.offset + member.length, container = member.parent
  // A container holding only this member and whitespace becomes empty again, as an append into `{}` or `[]` found it.
  if (members.length === 1 && container && [text.slice(container.offset + 1, member.offset),
    text.slice(end, container.offset + container.length - 1)].every(part => /^[\s,]*$/.test(part))) {
    const collapsed = removal(document, [{ offset: container.offset + 1, length: container.length - 2, content: "" }], path)
    if (collapsed !== undefined) return collapsed
  }
  const following = nextToken(text, end)
  const previous = index > 0 ? nextToken(text, members[index - 1].offset + members[index - 1].length) : undefined
  const comma = following.kind === SyntaxKind.CommaToken ? following.offset
    : previous?.kind === SyntaxKind.CommaToken ? previous.offset : undefined
  return removeLine(document, member.offset, end, "", comma, path)
}

/** Removes `start`..`end` (replaced by `content`) and the comma at `comma`, from the preceding line break
 * when only indentation precedes `start` on its line, unless that fails the parse check. */
function removeLine(document: PluginControlDocument, start: number, end: number, content: string,
  comma: number | undefined, path: (string | number)[]) {
  const text = document.text
  let lineStart = start
  while (lineStart > 0 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) lineStart--
  const starts = !content && text[lineStart - 1] === "\n" ? [lineStart - (text[lineStart - 2] === "\r" ? 2 : 1), start] : [start]
  for (const offset of starts) {
    const edits = [{ offset, length: end - offset, content }]
    if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" })
    const updated = removal(document, edits, path)
    if (updated !== undefined) return updated
  }
  return undefined
}

function removeNativeContainer(document: PluginControlDocument, keys: string[], removable: (value: unknown) => boolean) {
  if (!removable(readNativeSetting(document, keys))) return undefined
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
  const following = nextToken(text, property.offset + property.length)
  const previous = index > 0 ? nextToken(text, properties[index - 1].offset + properties[index - 1].length) : undefined
  const comma = following.kind === SyntaxKind.CommaToken ? following.offset
    : previous?.kind === SyntaxKind.CommaToken ? previous.offset : undefined
  // Without comments to keep, a property alone on its line takes the line with it.
  return removeLine(document, property.offset, property.offset + property.length, comments.join(" "), comma, keys)
}
