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

for (const transition of ["mounted", "reopen-after", "reopen-before"] as const) {
  test(`undo to the clean baseline during a save retains the resulting draft (${transition})`, async () => {
    fixture.disk = "baseline"; fixture.writing = false; fixture.fail = false
    let release!: () => void
    fixture.gate = new Promise<void>(resolve => { release = resolve })
    const path = `undo-${transition}.txt`
    const h = setup(path)
    let earlyReader: ReturnType<typeof setup> | undefined
    try {
      h.editor.adopt("baseline")
      h.editor.change("saved edit")
      const pending = h.editor.save()
      await Promise.resolve()
      assert.equal(fixture.writing, true)
      h.editor.change("baseline")
      assert.equal(h.editor.dirty(), false)
      if (transition !== "mounted") h.close()
      if (transition === "reopen-before") {
        earlyReader = setup(path)
        assert.equal(earlyReader.editor.reset(), "baseline")
        assert.equal(earlyReader.editor.saving(), true, "reopened reader fences authoritative reload during the write")
      }
      release(); await pending
      assert.equal(fixture.disk, "saved edit")
      if (transition === "mounted") {
        assert.equal(h.editor.text(), "baseline")
        assert.equal(h.editor.dirty(), true)
      }
      if (earlyReader) {
        assert.equal(earlyReader.editor.text(), "baseline")
        assert.equal(earlyReader.editor.dirty(), true, "completion publishes the new baseline to the reopened reader")
        assert.equal(earlyReader.editor.saving(), false)
      }
      const reopened = earlyReader ?? setup(path)
      try {
        if (!earlyReader) assert.equal(reopened.editor.reset(), "baseline")
        assert.equal(reopened.editor.dirty(), true)
        fixture.gate = null
        await reopened.editor.save()
        assert.equal(fixture.disk, "baseline")
        assert.equal(reopened.editor.dirty(), false)
      } finally { reopened.close() }
    } finally { release(); earlyReader?.close(); h.close() }
  })
}

test("a reopened reader shares pending-save edits and observes clean completion without an obsolete baseline", async () => {
  for (const newerText of ["saved edit", "newer edit"]) {
    fixture.disk = "baseline"; fixture.writing = false; fixture.fail = false
    let release!: () => void
    fixture.gate = new Promise<void>(resolve => { release = resolve })
    const path = `reopened-${newerText}.txt`, h = setup(path)
    let reopened: ReturnType<typeof setup> | undefined
    try {
      h.editor.adopt("baseline"); h.editor.change("saved edit")
      const pending = h.editor.save()
      await Promise.resolve(); h.close()
      reopened = setup(path)
      assert.equal(reopened.editor.reset(), "saved edit")
      reopened.editor.change(newerText)
      release(); await pending
      assert.equal(reopened.editor.text(), newerText)
      assert.equal(reopened.editor.dirty(), newerText !== "saved edit")
      assert.equal(reopened.editor.saving(), false)
      reopened.editor.discard()
    } finally { release(); reopened?.close(); h.close() }
  }
})

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
