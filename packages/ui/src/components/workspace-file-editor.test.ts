import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { FilePreviewTarget } from "../stores/files-preview"

type StoredDraft = { fingerprint: string; text: string }
const fixture = { disk: "baseline", version: "disk-version", expectedVersion: undefined as string | undefined,
  gate: null as Promise<void> | null, writing: false, fail: false,
  reads: [] as Array<(value: StoredDraft | undefined) => void>, durable: false, installed: true }
;(globalThis as any).__workspaceEditorFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    const sources: Record<string, string> = {
      "../lib/backend-client": `const f = globalThis.__workspaceEditorFixture;
        export const backendOf = () => ({ api: {
          previewWorkspaceFile: async () => ({ contents: f.disk, version: f.version }),
          writeWorkspaceFile: async (_id, _path, value, options) => {
            f.expectedVersion = options.expectedVersion;
            f.writing = true; await f.gate;
            if (f.fail) throw new Error('write failed'); f.disk = value;
          },
        } });`,
      "../lib/notifications": "export const showToastNotification = () => {}",
      "../stores/alerts": "export const showConfirmDialog = async () => true",
      "../stores/instances": `const f = globalThis.__workspaceEditorFixture;
        export const instances = () => f.durable ? new Map([["test", { id: "test", folder: "/repo" }]]) : new Map();`,
      "../lib/server-meta": `const f = globalThis.__workspaceEditorFixture;
        export const localServerMeta = { meta: () => f.installed ? { serverId: "fixture" } : undefined };
        export const getServerMeta = async () => localServerMeta.meta();`,
      "../stores/client-state": `const f = globalThis.__workspaceEditorFixture;
        export const keepRecoveredWorkspaceFileDraft = () => {};
        export const restoredWorkspaceFileDraft = () => undefined;
        export const refreshWorkspaceFileDraft = () => new Promise(resolve => f.reads.push(resolve));
        export const updateWorkspaceFileDraft = () => true;`,
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

test("two open readers share edits and adopt a fresh disk baseline after save", async () => {
  fixture.disk = "baseline"; fixture.gate = null; fixture.fail = false
  const first = setup("two-readers.txt"), second = setup("two-readers.txt")
  try {
    first.editor.adopt("baseline"); second.editor.adopt("baseline")
    first.editor.change("first edit")
    assert.equal(second.editor.text(), "first edit")
    second.editor.change("second edit")
    assert.equal(first.editor.text(), "second edit")
    await second.editor.save()
    assert.equal(fixture.disk, "second edit")
    assert.equal(fixture.expectedVersion, fixture.version)
    first.editor.adopt("disk changed")
    assert.equal(second.editor.text(), "disk changed")
    assert.equal(second.editor.dirty(), false)
  } finally { first.close(); second.close() }
})

test("a late recovery joins the shared editor instead of replacing newer text", async () => {
  fixture.durable = true
  const first = setup("concurrent-recovery.txt"), second = setup("concurrent-recovery.txt")
  try {
    first.editor.reset(); second.editor.reset()
    const a = first.editor.recover(), b = second.editor.recover()
    const stored = { fingerprint: "0".repeat(64), text: "stored draft" }
    fixture.reads.shift()!(stored)
    assert.equal(await a, "stored draft")
    first.editor.change("more recent edit")
    fixture.reads.shift()!(stored)
    assert.equal(await b, "more recent edit")
    second.editor.change("edit from the second reader")
    assert.equal(first.editor.text(), "edit from the second reader")
    second.editor.discard()
  } finally { first.close(); second.close(); fixture.durable = false }
})

test("a recovered draft replaces the clean shared disk view before either reader edits", async () => {
  fixture.durable = true
  const first = setup("clean-peer.txt"), second = setup("clean-peer.txt")
  try {
    first.editor.reset(); second.editor.reset()
    const a = first.editor.recover(), b = second.editor.recover()
    fixture.reads.shift()!(undefined)
    await a
    first.editor.adopt("disk contents")
    fixture.reads.shift()!({ fingerprint: "0".repeat(64), text: "recovered draft" })
    assert.equal(await b, "recovered draft")
    assert.equal(first.editor.text(), "recovered draft")
    first.editor.discard()
  } finally { first.close(); second.close(); fixture.durable = false }
})

test("a file stays read-only until its durable identity can be resolved", async () => {
  fixture.durable = true
  fixture.installed = false
  const { editor, close } = setup("unknown-installation.txt")
  try {
    editor.reset()
    await editor.recover()
    editor.adopt("disk contents")
    assert.equal(editor.editable(), false)
    editor.change("unscoped edit")
    assert.equal(editor.text(), "disk contents")
    fixture.installed = true
    const recovered = editor.recover()
    await new Promise<void>(resolve => setImmediate(resolve))
    fixture.reads.shift()!(undefined)
    await recovered
    assert.equal(editor.editable(), true)
    editor.adopt("disk contents")
    editor.change("scoped edit")
    assert.equal(editor.text(), "scoped edit")
    editor.discard()
  } finally { close(); fixture.durable = false; fixture.installed = true }
})

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
