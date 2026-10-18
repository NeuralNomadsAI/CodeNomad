import assert from "node:assert/strict"
import { test } from "node:test"
import { renderSnapshot, SnapshotScopeError, type AxNode } from "./snapshot"

type Spec = [role: string, name?: string, extra?: Partial<AxNode> & { props?: Record<string, unknown>; ignored?: boolean }, children?: Spec[]]

/** Builds a Chromium-shaped AX list (nodeId/parentId/childIds, backend ids in document order). */
function tree(spec: Spec): AxNode[] {
  const nodes: AxNode[] = []
  let next = 0
  const add = ([role, name, extra = {}, children = []]: Spec, parentId?: string): string => {
    const nodeId = `n${++next}`
    const { props, ...rest } = extra
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

const refs = () => {
  const issued = new Map<number, string>()
  return { ref: (id: number) => issued.get(id) ?? (issued.set(id, `e${id}`), `e${id}`), issued }
}

// Mirrors Chromium's tree for a label/input, a native select, a multiselect, a
// contenteditable and a list of rows (see the probe in the automation PR).
const form = tree(["RootWebArea", "", { props: { focusable: true } }, [
  ["none", "", { ignored: true }, [["main", "", {}, [
    ["LabelText", "", {}, [["StaticText", "Title ", {}, [["InlineTextBox", "Title "]]],
      ["textbox", "Title ", { value: { value: "Prefilled" }, props: { focusable: true, editable: "plaintext" } }, [
        ["generic", "", { props: { editable: "plaintext" } }, [["StaticText", "Prefilled"]]]]]]],
    ["LabelText", "", {}, [["StaticText", "Scenario "],
      ["combobox", "Scenario ", { value: { value: "Wayfinder" }, props: { focusable: true, expanded: false } }, [
        ["MenuListPopup", "", {}, [["none", "", { ignored: true }, [
          ["option", "Flexible mission", { props: { selected: false } }],
          ["option", "Wayfinder", { props: { selected: true } }],
          ["option", "Debugging", { props: { disabled: true } }]]]]]]]]],
    ["listbox", "Tags", { props: { focusable: true, multiselectable: true } }, [["none", "", { ignored: true }, [
      ["option", "a", { props: { selected: false } }], ["option", "b", { props: { selected: true } }]]]]],
    ["generic", "Notes", { value: { value: "Old notes" }, props: { focusable: true, editable: "richtext" } }, [["StaticText", "Old notes"]]],
    ["list", "", {}, [
      ["listitem", "", { props: { level: 1 } }, [["ListMarker", "• "], ["StaticText", "Session A"],
        ["button", "X", { description: { value: "Delete session" } }, [["StaticText", "X"]]]]],
      ["listitem", "", { props: { level: 1 } }, [["ListMarker", "• "], ["StaticText", "Session B"],
        ["button", "X", { description: { value: "Delete session" } }, [["StaticText", "X"]]]]]]],
    ["image", ""],
    ["button", "Save", { description: { value: "Save" }, props: { disabled: true } }],
  ]]]]]])

test("renders an indented outline: fields show values, selects show their options, wrappers and duplicates disappear", () => {
  const { ref } = refs()
  const snapshot = renderSnapshot(form, ref)
  assert.equal(snapshot.text, [
    "- main [e3]",
    "  - text \"Title\" [e5]",
    "  - textbox \"Title\" [e7] value=\"Prefilled\"",
    "  - text \"Scenario\" [e11]",
    "  - combobox \"Scenario\" [e12] value=\"Wayfinder\" collapsed",
    "    - option \"Flexible mission\" [e15]",
    "    - option \"Wayfinder\" [e16] selected",
    "    - option \"Debugging\" [e17] disabled",
    "  - listbox \"Tags\" [e18] multiselectable",
    "    - option \"a\" [e20]",
    "    - option \"b\" [e21] selected",
    "  - generic \"Notes\" [e22] value=\"Old notes\" editable",
    "  - list [e24]",
    "    - listitem [e25]",
    "      - text \"Session A\" [e27]",
    "      - button \"X\" [e28] description=\"Delete session\"",
    "    - listitem [e30]",
    "      - text \"Session B\" [e32]",
    "      - button \"X\" [e33] description=\"Delete session\"",
    "  - button \"Save\" [e36] disabled",
  ].join("\n"))
  assert.deepEqual([snapshot.collapsed, snapshot.shown, snapshot.total], [0, 20, 20])
})

test("a query keeps matches with their contents and only the ancestors leading to them", () => {
  const { ref } = refs()
  assert.equal(renderSnapshot(form, ref, { query: "scenario" }).text, [
    "- main [e3]",
    "  - text \"Scenario\" [e11]",
    "  - combobox \"Scenario\" [e12] value=\"Wayfinder\" collapsed",
    "    - option \"Flexible mission\" [e15]",
    "    - option \"Wayfinder\" [e16] selected",
    "    - option \"Debugging\" [e17] disabled",
  ].join("\n"))
  assert.match(renderSnapshot(form, ref, { query: "listitem" }).text, /- listitem \[e25\]\n {6}- text "Session A"/, "roles match too")
  assert.equal(renderSnapshot(form, ref, { query: "missing" }).text, "No element matches \"missing\"")
})

test("numeric values show, text survives a region's title, and queries ignore field labels", () => {
  const page = tree(["RootWebArea", "", {}, [
    ["slider", "Volume", { value: { value: 55 } as never }],
    ["region", "Mission editor", {}, [["paragraph", "", {}, [["StaticText", "Mission"]]]]],
    ["button", "Agent : Aucun", {}, [["StaticText", "Agent :"], ["StaticText", "Aucun"]]],
    ["link", "Docs", { props: { url: "https://example.test/docs" } }],
  ]])
  const { ref } = refs()
  assert.equal(renderSnapshot(page, ref).text, [
    "- slider \"Volume\" [e2] value=\"55\"",
    "- region \"Mission editor\" [e3]",
    "  - text \"Mission\" [e5]",
    "- button \"Agent : Aucun\" [e6]",
    "- link \"Docs\" [e9] url=\"https://example.test/docs\"",
  ].join("\n"))
  assert.equal(renderSnapshot(page, ref, { query: "url" }).text, "No element matches \"url\"")
  assert.equal(renderSnapshot(page, ref, { query: "55" }).text, "- slider \"Volume\" [e2] value=\"55\"", "values are searchable")
})

test("a scoped snapshot renders one element's subtree or reports that it left the page", () => {
  const { ref } = refs()
  assert.equal(renderSnapshot(form, ref, { rootBackendNodeId: 30 }).text,
    "- listitem [e30]\n  - text \"Session B\" [e32]\n  - button \"X\" [e33] description=\"Delete session\"")
  assert.throws(() => renderSnapshot(form, ref, { rootBackendNodeId: 999 }), SnapshotScopeError)
})

test("an oversized page collapses its large subtree and keeps small siblings whole", () => {
  const messages: Spec[] = Array.from({ length: 300 }, (_, index) =>
    ["article", `Message ${index}`, {}, [["paragraph", "", {}, [["StaticText", `Body of message ${index} `.repeat(4)]]]]])
  const page = tree(["RootWebArea", "", {}, [
    ["toolbar", "Conversation", {}, [["button", "Search"], ["button", "Stop"]]],
    ["log", "Transcript", {}, messages],
    ["form", "Composer", {}, [["textbox", "Message", { value: { value: "Draft" } }], ["button", "Send"]]],
  ]])
  const snapshot = renderSnapshot(page, refs().ref, { budget: 4_000 })
  assert.ok(snapshot.text.length <= 4_000, `${snapshot.text.length} characters`)
  assert.match(snapshot.text, /^- toolbar "Conversation" \[e2\]\n {2}- button "Search" \[e3\]\n {2}- button "Stop" \[e4\]\n- log "Transcript"/)
  assert.match(snapshot.text, /- form "Composer" \[\w+\]\n {2}- textbox "Message" \[\w+\] value="Draft"\n {2}- button "Send" \[\w+\]$/)
  assert.match(snapshot.text, /- \(\+\d+ more\)/, "omitted messages are announced in place")
  assert.match(snapshot.text, /"Message 0"/)
  assert.match(snapshot.text, /"Message 299"/, "the newest messages stay visible after the gap")
  assert.ok(snapshot.collapsed > 0 && snapshot.shown < snapshot.total)
})

test("collapsed subtrees keep their ref and say how much they hide", () => {
  const big: Spec = ["region", "Big", {}, Array.from({ length: 50 }, (_, index) => ["button", `Item ${index} `.repeat(30)] as Spec)]
  const page = tree(["RootWebArea", "", {}, [big, ["button", "Small"]]])
  const snapshot = renderSnapshot(page, refs().ref, { budget: 200 })
  assert.equal(snapshot.text, "- region \"Big\" [e2] (+50 hidden)\n- button \"Small\" [e53]")
  assert.deepEqual([snapshot.collapsed, snapshot.shown, snapshot.total], [1, 2, 52])
})

test("outlines never exceed their budget, whatever the shape of the page", () => {
  let seed = 7
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
  const grow = (depth: number): Spec => ["group", `Node ${Math.floor(random() * 1e6)}`.repeat(1 + Math.floor(random() * 3)), {},
    depth > 5 ? [] : Array.from({ length: Math.floor(random() * 6) }, () => grow(depth + 1))]
  for (let round = 0; round < 40; round++) {
    const page = tree(["RootWebArea", "", {}, Array.from({ length: 1 + Math.floor(random() * 8) }, () => grow(0))])
    for (const budget of [200, 1_000, 5_000]) {
      const snapshot = renderSnapshot(page, refs().ref, { budget })
      assert.ok(snapshot.text.length <= budget, `round ${round}: ${snapshot.text.length} > ${budget}`)
      assert.ok(snapshot.shown > 0)
    }
  }
})
