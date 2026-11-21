/** Parity cases of the page engine for its Rust port in the Tauri host (`engine.cases.json`, written by
 * `scripts/build-page-function-registry.ts`, checked by driver.test.ts): outlines, key chords and the exact
 * operation sequence each action sends to a scripted page, checkpoints included. */
import { readFileSync } from "node:fs"
import { bindRefs, performAction } from "./actions"
import { operationDriver } from "./driver"
import { keyChord } from "./keys"
import type { RefAction } from "./parse"
import type { PageOperation, SemanticNode } from "./protocol"
import { semanticTree, snapshotTree } from "./semantic-tree"
import { renderSnapshot, type AxNode, type SnapshotOptions } from "./snapshot"

type Spec = [role: string, name?: string, extra?: Record<string, unknown>, children?: Spec[]]
function tree(spec: Spec): AxNode[] {
  const nodes: AxNode[] = []
  let next = 0
  const add = ([role, name, extra = {}, children = []]: Spec, parentId?: string): string => {
    const nodeId = `n${++next}`
    const { props, ...rest } = extra as { props?: Record<string, unknown> }
    const node: AxNode = { nodeId, ...(parentId ? { parentId } : {}), backendDOMNodeId: next, role: { value: role },
      ...(name !== undefined ? { name: { value: name } } : {}),
      ...(props ? { properties: Object.entries(props).map(([key, value]) => ({ name: key, value: { value } })) } : {}), ...rest }
    nodes.push(node)
    node.childIds = children.map(child => add(child, nodeId))
    return nodeId
  }
  add(spec)
  return nodes
}

function pages(): Record<string, AxNode[]> {
  let seed = 11
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
  const grow = (depth: number): Spec => [["group", "button", "region", "list", "listitem"][Math.floor(random() * 5)],
    `Node ${Math.floor(random() * 1e6)} `.repeat(1 + Math.floor(random() * 3)), random() < 0.2 ? { props: { focusable: true, expanded: random() < 0.5 } } : {},
    depth > 4 ? [] : Array.from({ length: Math.floor(random() * 6) }, () => grow(depth + 1))]
  return {
    fixture: JSON.parse(readFileSync(new URL("./driver.fixture.json", import.meta.url), "utf8")),
    form: tree(["RootWebArea", "", { props: { focusable: true } }, [["none", "", { ignored: true }, [["main", "", {}, [
      ["LabelText", "", {}, [["StaticText", "Title ", {}, [["InlineTextBox", "Title "]]],
        ["textbox", "Title ", { value: { value: "Prefilled" }, props: { focusable: true, editable: "plaintext" } }, [["generic", "", { props: { editable: "plaintext" } }, [["StaticText", "Prefilled"]]]]]]],
      ["combobox", "Scenario ", { value: { value: "Wayfinder" }, props: { focusable: true, expanded: false } }, [["MenuListPopup", "", {}, [
        ["option", "Flexible mission", { props: { selected: false } }], ["option", "Wayfinder", { props: { selected: true } }], ["option", "Debugging", { props: { disabled: true } }]]]]],
      ["generic", "Notes", { value: { value: "Old notes" }, props: { focusable: true, editable: "richtext" } }, [["StaticText", "Old notes"]]],
      ["list", "", {}, [["listitem", "", { props: { level: 1 } }, [["ListMarker", " "], ["StaticText", "Session A"], ["button", "X", { description: { value: "Delete session" } }, [["StaticText", "X"]]]]]]],
      ["checkbox", "Remember", { props: { checked: "true", required: true, invalid: "true" } }], ["switch", "Dark", { props: { checked: false, pressed: "mixed" } }],
      ["slider", "Volume", { value: { value: 55.5 } }], ["heading", "Plans", { props: { level: 2 } }], ["link", "Docs   page", { props: { url: "https://example.test/" + "x".repeat(130) } }],
      ["region", "Mission editor", {}, [["paragraph", "", {}, [["StaticText", "Mission"]]]]],
      ["button", "Agent : Aucun", {}, [["StaticText", "Agent :"], ["StaticText", "Aucun"]]], ["image", ""], ["img", "Logo"],
      ["textbox", "É" + "é".repeat(130), { value: { value: "😀 emoji" } }], ["button", "Save", { description: { value: "save" }, props: { disabled: true, busy: "true" } }],
    ]]]]]]),
    transcript: tree(["RootWebArea", "", {}, [["toolbar", "Conversation", {}, [["button", "Search"], ["button", "Stop"]]],
      ["log", "Transcript", {}, Array.from({ length: 300 }, (_, index) => ["article", `Message ${index}`, {}, [["paragraph", "", {}, [["StaticText", `Body of message ${index} `.repeat(4)]]]]] as Spec)],
      ["form", "Composer", {}, [["textbox", "Message", { value: { value: "Draft" } }], ["button", "Send"]]]]]),
    random: tree(["RootWebArea", "", {}, Array.from({ length: 6 }, () => grow(0))]),
    empty: tree(["RootWebArea", "", {}, [["generic", ""]]]),
  }
}

const SNAPSHOTS: Array<[string, SnapshotOptions]> = [["fixture", {}], ["fixture", { query: "plan" }], ["fixture", { rootBackendNodeId: 14 }], ["fixture", { budget: 200 }],
  ["form", {}], ["form", { query: "SESSION" }], ["form", { query: "listitem" }], ["form", { query: "55.5" }], ["form", { query: "missing" }], ["form", { budget: 300 }],
  ["form", { rootBackendNodeId: 22 }], ["transcript", { budget: 4_000 }], ["transcript", { budget: 200 }], ["transcript", {}], ["random", { budget: 200 }],
  ["random", { budget: 1_000 }], ["random", { budget: 5_000 }], ["random", {}], ["empty", {}], ["random", { budget: 600, query: "node" }]]

const CHORDS = ["a", "A", "Enter", "Space", "space", "Escape", "esc", "arrowdown", "F5", "f12", "/", "?", "Control+Shift+K", "Shift+Tab", "Shift+a",
  "Mod+k", "ctrl+cmd+alt+x", "+", "Alt+0", "Shift+1", "Hyper+Q", "Enterr", "Control+", "é", "Shift++", "x".repeat(65), " Control + k "]

/** A scripted page over the fixture's nodes: boxes per node, an overlay over node 13, select failures. */
function scripted(nodes: SemanticNode[], log: unknown[]) {
  const box = (node: number) => node === 14 ? undefined : { x: 20 + (node % 7) * 100, y: 40 + node * 20, w: 80, h: 16 }
  return async (operation: PageOperation): Promise<Record<string, unknown>> => {
    log.push(operation)
    switch (operation.op) {
      case "tree": return { nodes }
      case "resolve": if (operation.node === 999) throw new Error("No node with given id"); return { handle: `h${operation.node}` }
      case "geometry": { const b = box(operation.node); return { quads: b ? [[b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h]] : [] } }
      case "viewport": return { width: 800, height: 600 }
      case "hit-test": { const node = [10, 11, 12, 13, 15, 16].find(id => { const b = box(id)!; return operation.x >= b.x && operation.x < b.x + b.w && operation.y >= b.y && operation.y < b.y + b.h })
        return node === 13 ? { node: 11 } : node === undefined ? {} : { node } }
      case "call": {
        const handle = operation.handle
        switch (operation.function) {
          case "option-click": return handle === "h15" ? { value: ["Pro"] } : handle === "h14" ? { exception: "Error: codenomad:is-select\n    at <anonymous>" } : { value: null }
          case "field": return { handle: `f${handle}` }
          case "prepare": return handle === "fh16" ? { value: "append" } : handle === "fh10" ? { exception: "Error: codenomad:not-text" } : { value: "insert" }
          case "read-value": return { value: "typed" }
          case "select": return handle === "h13" ? { exception: "Error: codenomad:no-option:Gold" } : { value: ["Pro"] }
          case "receives": return { value: 'div "Overlay"' }
          case "describe": return { value: 'textbox "Name"' }
          case "active-element": return { handle: "active" }
          case "document-root": return { handle: "document" }
          case "contains": return { value: (operation.args[0] as string) === "Save" }
          case "input-acceptance": return { value: { inputDelayMs: 0 } }
          case "mark-input": return { value: 1_700_000_000.5 }
          case "unmark-input": return { value: true }
          case "focus": return handle === "h10" ? { exception: "Error: codenomad:unfocusable" } : { value: null }
          default: return { value: null }
        }
      }
      default: return {}
    }
  }
}

const ACTIONS: RefAction[] = [
  { action: "click", ref: "e11" }, { action: "click", ref: "e11", button: "right" }, { action: "click", ref: "e14" }, { action: "click", ref: "e15" },
  { action: "click", ref: "e13" }, { action: "click", ref: "e999" }, { action: "type", ref: "e12", text: "abc", clear: true },
  { action: "type", ref: "e12", text: "", clear: true }, { action: "type", ref: "e16", text: "7", clear: false }, { action: "type", ref: "e10", text: "x", clear: true },
  { action: "select", ref: "e14", values: ["Pro"] }, { action: "select", ref: "e13", values: ["Gold"] }, { action: "hover", ref: "e12" }, { action: "hover", ref: "e14" },
  { action: "drag", ref: "e11", to: "e12" }, { action: "scroll", direction: "down", amount: 300 }, { action: "scroll", ref: "e12", direction: "left", amount: 40 },
  { action: "press", key: "Control+K" }, { action: "press", key: "Enter", ref: "e12" }, { action: "press", key: "a", ref: "e10" },
  { action: "wait", text: "Save", gone: false, timeout: 0 }, { action: "wait", text: "Save", gone: true, timeout: 0 }, { action: "wait", text: "Other", gone: false, timeout: 0 },
]

export async function engineCases() {
  const all = pages()
  const snapshots = SNAPSHOTS.map(([page, options]) => {
    const nodes = semanticTree(all[page])
    try {
      const { text, collapsed } = renderSnapshot(snapshotTree(nodes), id => `e${id}`, options)
      return { page, options, text, collapsed }
    } catch (error) { return { page, options, error: (error as Error).message } }
  })
  const keys = CHORDS.flatMap(chord => (["win32", "darwin"] as const).map(platform => {
    try { return { chord, platform, events: keyChord(chord, platform) } } catch (error) { return { chord, platform, error: (error as Error).message } }
  }))
  const nodes = semanticTree(all.fixture)
  const actions = []
  for (const mark of [true, false]) for (const action of ACTIONS) {
    const log: unknown[] = []
    const send = scripted(nodes, log)
    const driver = operationDriver("cdp", send, async () => { log.push({ checkpoint: true }) }, mark)
    const session = { driver, checkpoint: async () => { log.push({ checkpoint: true }) }, markAutomation: mark }
    let outcome
    try {
      const result = await performAction(session, bindRefs(action, ref => Number(ref.slice(1))))
      outcome = { result: "waitedMs" in result ? { ...result, waitedMs: 0 } : result }
    } catch (error) { outcome = { error: (error as Error).message } }
    actions.push({ mark, action, operations: log, ...outcome })
  }
  return { pages: Object.fromEntries(Object.entries(all).map(([name, page]) => [name, semanticTree(page)])), snapshots, keys, actions }
}
