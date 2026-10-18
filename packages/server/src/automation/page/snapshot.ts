/** Accessibility snapshot shared by the automation tools: an indented outline of the
 * page with refs, bounded by a character budget. When the page does not fit, large
 * subtrees are collapsed (smaller siblings stay whole) and each collapsed line says
 * how much it hides, instead of silently cutting the end of the page. */

export interface AxNode {
  nodeId?: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: unknown }
  name?: { value?: unknown }
  description?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

export interface SnapshotOptions {
  /** Render only this DOM node's subtree. */
  rootBackendNodeId?: number
  /** Keep nodes whose role, name, value or description matches, with their contents and ancestors. */
  query?: string
  /** Approximate character budget of the outline. */
  budget?: number
}

export interface Snapshot {
  text: string
  /** Lines that hide part of the page: a collapsed subtree or omitted siblings. */
  collapsed: number
  /** Nodes in the outline before any collapsing. */
  total: number
  /** Nodes actually shown. */
  shown: number
}

export class SnapshotScopeError extends Error {}

export const DEFAULT_SNAPSHOT_BUDGET = 32_000
const STRING_LIMIT = 120
const REF_COST = 10
const SKIPPED_ROLES = new Set(["InlineTextBox", "ListMarker", "LineBreak"])
/** Wrappers that only matter through their name, value or editability. */
const TRANSPARENT_ROLES = new Set(["RootWebArea", "generic", "none", "presentation", "LabelText", "MenuListPopup", "paragraph",
  "Section", "sectionheader", "sectionfooter", "group", "strong", "emphasis", "mark", "subscript", "superscript", "time",
  "abbr", "code", "Pre", "blockquote", "figure", "Ruby", "DescriptionListDetail", "DescriptionListTerm"])
const DECORATIVE_ROLES = new Set(["image", "img", "graphics-symbol", "graphics-document", "SvgRoot", "Canvas"])
/** Date/time inputs expose their internal day/month/year spinbuttons as children. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "Date", "DateTime", "InputTime"])
const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"])
/** Roles whose accessible name is usually computed from their descendants' text. */
const NAME_FROM_CONTENTS = new Set(["button", "link", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
  "heading", "cell", "gridcell", "columnheader", "rowheader", "checkbox", "radio", "switch", "tooltip", "LabelText", "DisclosureTriangle"])
const TRUE_STATES = ["disabled", "focused", "required", "readonly", "multiselectable", "modal", "busy"]

interface View {
  head: string
  tail: string
  name: string
  /** Role, name, value and description that `query` matches, never the field labels around them. */
  searchable: string
  backend?: number
  children: View[]
  /** Views in this subtree, including itself. */
  size: number
  /** Characters of the full rendering at its depth. */
  full: number
}

type Emitted = { view: View; budget: number } | { more: number }

export function renderSnapshot(nodes: readonly AxNode[], ref: (backendNodeId: number) => string, options: SnapshotOptions = {}): Snapshot {
  const byId = new Map<string, AxNode>()
  for (const node of nodes) if (node.nodeId !== undefined) byId.set(node.nodeId, node)
  let roots: AxNode[]
  if (options.rootBackendNodeId !== undefined) {
    const matches = nodes.filter(node => node.backendDOMNodeId === options.rootBackendNodeId)
    const root = matches.find(node => !node.ignored) ?? matches[0]
    if (!root) throw new SnapshotScopeError("The element is no longer in the page; inspect again")
    roots = [root]
  } else roots = nodes.filter(node => node.parentId === undefined || !byId.has(node.parentId)).slice(0, 1)

  const visited = new Set<AxNode>()
  const build = (node: AxNode, context: Context): View[] => {
    if (visited.has(node)) return []
    visited.add(node)
    const role = text(node.role)
    if (SKIPPED_ROLES.has(role)) return []
    const kids = (inner: Context) => (node.childIds ?? []).flatMap(id => {
      const child = byId.get(id)
      return child ? build(child, inner) : []
    })
    if (node.ignored) return kids(context)
    const name = clip(text(node.name)), value = clip(text(node.value))
    if (role === "StaticText") {
      // Text repeating its printed parent's name adds nothing: the whole name, or a part of a
      // name computed from contents (a button's label pieces); a region's title keeps its text.
      const normalized = normalize(name)
      if (!normalized || (context.name && (context.name === normalized || (context.fromContents && context.name.includes(normalized))))) return []
      return [view(`text ${quote(name)}`, "", name, node, name)]
    }
    const properties = new Map((node.properties ?? []).map(property => [property.name ?? "", property.value?.value]))
    const editable = typeof properties.get("editable") === "string" && properties.get("editable") !== ""
    if (TRANSPARENT_ROLES.has(role) && !name && !value && !editable) return kids(context)
    if (DECORATIVE_ROLES.has(role) && !name) return []
    // A field shows its content as its value; its inner text nodes would repeat it.
    const field = FIELD_ROLES.has(role) || editable
    const children = field ? [] : kids({ name: normalize(name), fromContents: NAME_FROM_CONTENTS.has(role) })
    if (!name && !value && !children.length && !interactive(role, properties)) return []
    const description = clip(text(node.description))
    const tail = [
      value && value !== name ? ` value=${quote(value)}` : "",
      description && normalize(description) !== normalize(name) ? ` description=${quote(description)}` : "",
      ...states(role, properties, editable && !FIELD_ROLES.has(role)),
    ].join("")
    const result = view(`${role}${name ? ` ${quote(name)}` : ""}`, tail, name, node, `${role} ${name} ${value} ${description}`)
    result.children = children
    return [result]
  }

  let forest = roots.flatMap(root => build(root, {}))
  const query = normalize(options.query ?? "")
  if (query) forest = forest.flatMap(item => filter(item, query))
  const total = measure(forest, 0)
  if (!forest.length) {
    return { text: query ? `No element matches ${quote(options.query!.trim())}` : "No accessible elements found", collapsed: 0, total: 0, shown: 0 }
  }
  const lines: string[] = []
  let collapsed = 0, shown = 0
  const emitLine = (item: View, depth: number, suffix = "") => {
    lines.push(`${indent(depth)}- ${item.head}${item.backend === undefined ? "" : ` [${ref(item.backend)}]`}${item.tail}${suffix}`)
    shown++
  }
  const emitFull = (item: View, depth: number) => {
    emitLine(item, depth)
    for (const child of item.children) emitFull(child, depth + 1)
  }
  const emitList = (items: Emitted[], depth: number) => {
    for (const item of items) {
      if ("more" in item) { lines.push(`${indent(depth)}- (+${item.more} more)`); collapsed++ }
      else render(item.view, depth, item.budget)
    }
  }
  const render = (item: View, depth: number, budget: number) => {
    if (item.full <= budget) return emitFull(item, depth)
    const layout = allocate(item.children, depth + 1, budget - own(item, depth))
    if (!layout) { emitLine(item, depth, hiddenSuffix(item.size - 1)); collapsed++; return }
    emitLine(item, depth)
    emitList(layout, depth + 1)
  }
  const top = allocate(forest, 0, Math.max(options.budget ?? DEFAULT_SNAPSHOT_BUDGET, 200))
  emitList(top ?? [{ view: forest[0], budget: minimum(forest[0], 0) }, ...forest.length > 1 ? [{ more: forest.length - 1 }] : []], 0)
  return { text: lines.join("\n"), collapsed, total, shown }
}

/** The nearest printed ancestor's normalized name, and whether it was computed from its contents. */
interface Context { name?: string; fromContents?: boolean }

function view(head: string, tail: string, name: string, node: AxNode, searchable: string): View {
  return { head, tail, name: normalize(name), searchable: normalize(searchable),
    ...(Number.isInteger(node.backendDOMNodeId) ? { backend: node.backendDOMNodeId } : {}), children: [], size: 1, full: 0 }
}

function interactive(role: string, properties: Map<string, unknown>): boolean {
  return ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "listbox"].includes(role) || properties.get("focusable") === true
}

function states(role: string, properties: Map<string, unknown>, editable: boolean): string[] {
  const result: string[] = []
  const checked = properties.get("checked")
  if (CHECKABLE_ROLES.has(role) && checked !== undefined) result.push(checked === "true" || checked === true ? " checked" : checked === "mixed" ? " checked=mixed" : " unchecked")
  const pressed = properties.get("pressed")
  if (pressed === "true" || pressed === true) result.push(" pressed")
  else if (pressed === "mixed") result.push(" pressed=mixed")
  const expanded = properties.get("expanded")
  if (expanded !== undefined) result.push(expanded === true || expanded === "true" ? " expanded" : " collapsed")
  const selected = properties.get("selected")
  if (selected === true || selected === "true") result.push(" selected")
  for (const state of TRUE_STATES) if (properties.get(state) === true || properties.get(state) === "true") result.push(` ${state}`)
  const invalid = properties.get("invalid")
  if (typeof invalid === "string" && invalid !== "false") result.push(" invalid")
  if (editable) result.push(" editable")
  const level = properties.get("level")
  if (role === "heading" && typeof level === "number") result.push(` level=${level}`)
  const url = properties.get("url")
  if (role === "link" && typeof url === "string" && url) result.push(` url=${quote(clip(url))}`)
  return result
}

/** A match keeps its whole subtree; other nodes survive only as ancestors of a match. */
function filter(item: View, query: string): View[] {
  if (item.searchable.includes(query)) return [item]
  const children = item.children.flatMap(child => filter(child, query))
  return children.length ? [{ ...item, children }] : []
}

function measure(items: View[], depth: number): number {
  let count = 0
  for (const item of items) {
    const inside = measure(item.children, depth + 1)
    item.size = 1 + inside
    item.full = own(item, depth) + item.children.reduce((sum, child) => sum + child.full, 0)
    count += item.size
  }
  return count
}

function own(item: View, depth: number): number {
  return depth * 2 + 3 + item.head.length + item.tail.length + (item.backend === undefined ? 0 : REF_COST)
}

function minimum(item: View, depth: number): number {
  return own(item, depth) + (item.children.length ? hiddenSuffix(item.size - 1).length : 0)
}

/** Shares a budget among siblings: small ones stay whole, large ones are collapsed inside;
 * when even collapsed lines do not fit, the first and last siblings are kept around a gap. */
function allocate(items: View[], depth: number, budget: number): Emitted[] | undefined {
  if (!items.length) return []
  const minimums = items.map(item => minimum(item, depth))
  const floor = minimums.reduce((sum, value) => sum + value, 0)
  if (floor <= budget) {
    const share = (level: number) => items.reduce((sum, item, index) => sum + Math.min(item.full, Math.max(minimums[index], level)), 0)
    let low = 0, high = Math.max(...items.map(item => item.full))
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (share(middle) <= budget) low = middle
      else high = middle - 1
    }
    return items.map((item, index) => ({ view: item, budget: Math.min(item.full, Math.max(minimums[index], low)) }))
  }
  const gap = depth * 2 + 16
  const head: number[] = [], tail: number[] = []
  let used = gap, front = 0, back = items.length - 1
  while (front <= back) {
    const fromFront = head.length <= tail.length
    const index = fromFront ? front : back
    if (used + minimums[index] > budget) break
    used += minimums[index]
    if (fromFront) head.push(front++)
    else tail.unshift(back--)
  }
  if (!head.length && !tail.length) return undefined
  const omitted = items.length - head.length - tail.length
  const pick = (index: number): Emitted => ({ view: items[index], budget: minimums[index] })
  return [...head.map(pick), ...omitted ? [{ more: omitted }] : [], ...tail.map(pick)]
}

function hiddenSuffix(count: number): string {
  return ` (+${count} hidden)`
}

function indent(depth: number): string {
  return "  ".repeat(depth)
}

/** Chromium reports slider, spinbutton and progress values as numbers. */
function text(value: { value?: unknown } | undefined): string {
  const raw = typeof value?.value === "number" && Number.isFinite(value.value) ? String(value.value) : value?.value
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : ""
}

function clip(value: string): string {
  return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT - 1)}…` : value
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function quote(value: string): string {
  return JSON.stringify(value)
}
