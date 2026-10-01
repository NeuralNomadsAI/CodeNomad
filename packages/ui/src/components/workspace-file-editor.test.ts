import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { FilePreviewTarget } from "../stores/files-preview"

const fixture = { disk: "baseline", gate: null as Promise<void> | null, writing: false, fail: false }
;(globalThis as any).__workspaceEditorFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    const sources: Record<string, string> = {
      "../lib/api-client": `const f = globalThis.__workspaceEditorFixture;
        export const serverApi = {
          previewWorkspaceFile: async () => ({ contents: f.disk }),
          writeWorkspaceFile: async (_id, _path, value) => {
            f.writing = true; await f.gate;
            if (f.fail) throw new Error('write failed'); f.disk = value;
          },
        };`,
      "../lib/notifications": "export const showToastNotification = () => {}",
      "../stores/alerts": "export const showConfirmDialog = async () => true",
    }
    if (context.parentURL?.endsWith("/workspace-file-editor.ts") && sources[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
after(() => { hooks.deregister(); delete (globalThis as any).__workspaceEditorFixture })
const { createRoot } = await import("solid-js")
const { useWorkspaceFileEditor } = await import("./workspace-file-editor")

function setup(path: string) {
  const target: FilePreviewTarget = { kind: "workspace", sessionId: "session", slug: "root", directory: "/repo", path }
  let close!: () => void
  const editor = createRoot(dispose => {
    close = dispose
    return useWorkspaceFileEditor({ instanceId: "test", target: () => target, active: () => true,
      t: key => key, onError: () => {} })
  })
  return { editor, close }
}

for (const closeDuringSave of [false, true]) {
  test(`undo to the clean baseline during a save retains the resulting draft (closed: ${closeDuringSave})`, async () => {
    fixture.disk = "baseline"; fixture.writing = false; fixture.fail = false
    let release!: () => void
    fixture.gate = new Promise<void>(resolve => { release = resolve })
    const h = setup(`undo-${closeDuringSave}.txt`)
    try {
      h.editor.adopt("baseline")
      h.editor.change("saved edit")
      const pending = h.editor.save()
      await Promise.resolve()
      assert.equal(fixture.writing, true)
      h.editor.change("baseline")
      assert.equal(h.editor.dirty(), false)
      if (closeDuringSave) h.close()
      release(); await pending
      assert.equal(fixture.disk, "saved edit")
      if (!closeDuringSave) {
        assert.equal(h.editor.text(), "baseline")
        assert.equal(h.editor.dirty(), true)
      }
      const reopened = setup(`undo-${closeDuringSave}.txt`)
      try {
        assert.equal(reopened.editor.reset(), "baseline")
        assert.equal(reopened.editor.dirty(), true)
        fixture.gate = null
        await reopened.editor.save()
        assert.equal(fixture.disk, "baseline")
        assert.equal(reopened.editor.dirty(), false)
      } finally { reopened.close() }
    } finally { release(); h.close() }
  })
}

test("a failed write removes a temporarily clean revert rather than retaining a false dirty draft", async () => {
  fixture.disk = "baseline"; fixture.writing = false; fixture.fail = true
  let release!: () => void
  fixture.gate = new Promise<void>(resolve => { release = resolve })
  const h = setup("failure.txt")
  try {
    h.editor.adopt("baseline"); h.editor.change("saved edit")
    const pending = h.editor.save()
    await Promise.resolve()
    h.editor.change("baseline")
    release(); await pending
    assert.equal(h.editor.dirty(), false)
    const reopened = setup("failure.txt")
    try { assert.equal(reopened.editor.reset(), undefined) } finally { reopened.close() }
  } finally { fixture.fail = false; release(); h.close() }
})
