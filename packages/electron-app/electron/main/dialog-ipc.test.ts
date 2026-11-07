import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from "electron"
import { setupDialogIPC } from "./dialog-ipc"

function harness(results: OpenDialogReturnValue[]) {
  const handlers = new Map<string, Function>()
  const requests: OpenDialogOptions[] = []
  const window = {} as BrowserWindow
  const event = {} as IpcMainInvokeEvent
  setupDialogIPC({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    resolveWindow: (received) => {
      assert.equal(received, event)
      return window
    },
    showOpenDialog: async (parent, options) => {
      assert.equal(parent, window)
      requests.push(options)
      return results.shift()!
    },
  })
  const open = (request: unknown) => handlers.get("dialog:open")!(event, request)
  return { open, requests }
}

test("a dialog without a default path starts in the folder of the last selection", async () => {
  const project = path.join(path.sep, "work", "project")
  const { open, requests } = harness([
    { canceled: false, filePaths: [path.join(project, "notes.md"), path.join(project, "todo.md")] },
    { canceled: false, filePaths: [path.join(project, "src", "main.ts")] },
  ])
  assert.deepEqual(await open({ mode: "file", multiple: true }), { canceled: false, paths: [path.join(project, "notes.md"), path.join(project, "todo.md")] })
  assert.equal(requests[0].defaultPath, undefined)
  assert.deepEqual(requests[0].properties, ["openFile", "multiSelections"])
  await open({ mode: "file" })
  assert.equal(requests[1].defaultPath, project)
})

test("an explicit default path wins, and a canceled dialog keeps the remembered folder", async () => {
  const project = path.join(path.sep, "work", "project")
  const explicit = path.join(path.sep, "work", "other")
  const { open, requests } = harness([
    { canceled: false, filePaths: [path.join(project, "child")] },
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: [path.join(project, "child")] },
  ])
  await open({ mode: "directory" })
  assert.deepEqual(requests[0].properties, ["openDirectory", "createDirectory"])
  assert.deepEqual(await open({ mode: "directory", defaultPath: explicit }), { canceled: true, paths: [] })
  assert.equal(requests[1].defaultPath, explicit)
  await open({ mode: "directory" })
  assert.equal(requests[2].defaultPath, project)
})

test("an invalid request is refused before any dialog opens", async () => {
  const { open, requests } = harness([])
  await assert.rejects(open({ mode: "save" }), /Invalid dialog request/)
  assert.equal(requests.length, 0)
})
