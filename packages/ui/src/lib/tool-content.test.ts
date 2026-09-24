import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSessionMessage } from "../stores/message-v2/normalizers"
import type { SessionMessageInfo, ToolContent } from "@opencode/client"
import { isToolImageContent, toolImageSource } from "./tool-content"
import { defaultRenderer } from "../components/tool-call/renderers/default"
import { buildToolSpeechText } from "../components/tool-call/utils"
import type { ToolRendererContext } from "../components/tool-call/types"

const file = { type: "file" as const, mime: "image/png", uri: "data:image/png;base64,c2VjcmV0LWltYWdlLWJ5dGVz" }
test("native images survive normalization without entering copy, local search or speech text", () => {
  const cases: Array<[ToolContent, ...ToolContent[]]> = [[file], [{ type: "text", text: "Generated image" }, file]]
  for (const content of cases) {
    const source: SessionMessageInfo = { id: "m", type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, time: { created: 1 },
      content: [{ id: "t", type: "tool", name: "mcp_image", time: { created: 1 },
        state: { status: "completed", input: {}, content } }] }
    const part = normalizeSessionMessage("s", source).message.parts[0]
    assert.equal(part.type, "tool")
    if (part.type !== "tool") return
    const state = part.state!
    assert.equal(state.status, "completed")
    if (state.status !== "completed") return
    assert.deepEqual(state.content, content)
    assert.equal(state.content?.filter(isToolImageContent).length, 1)
    const chrome = defaultRenderer.getOutputChrome!({ toolState: () => state } as ToolRendererContext)
    const search = defaultRenderer.getSearchText!({ toolCall: part, toolState: state, toolName: "mcp_image" })
    const speech = buildToolSpeechText({ title: "Image tool", state, t: key => key })
    for (const text of [chrome?.copyText ?? "", search.join(" "), speech]) assert.ok(!text.includes("base64"))
    assert.equal(chrome?.copyText, content.length === 1 ? undefined : "Generated image")
  }
})

test("image loading permits image data and HTTP sources but rejects local/executable and mismatched data URLs", () => {
  assert.equal(toolImageSource(file), file.uri)
  for (const uri of ["https://example.com/image.png", "http://localhost:1234/image.png"]) {
    assert.equal(toolImageSource({ ...file, uri }), uri)
  }
  for (const uri of ["file:///etc/image.png", "javascript:alert(1)", "data:text/html;base64,AA==", "data:image/jpeg;base64,AA==", "https://user:secret@example.com/image.png"]) {
    assert.equal(toolImageSource({ ...file, uri }), undefined)
  }
  assert.equal(isToolImageContent({ type: "text", text: file.uri }), false)
})
