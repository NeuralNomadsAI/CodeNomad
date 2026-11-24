import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import test from "node:test"
import type { ChildProcess } from "node:child_process"
import { defaultOpenMode, editorCandidates, looksLikeText, openLocalPath, openWorkspaceTarget } from "./workspace-open"

test("selects only the requested editor", () => {
  assert.deepEqual(editorCandidates("zed", "linux", {}), [{ command: "zed", verifyStart: true }])
  assert.deepEqual(editorCandidates("vscodium", "darwin", {}), [
    { command: "/usr/bin/open", args: ["-a", "VSCodium"], waitForExit: true },
  ])
})

test("opens only paths inside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-workspace-"))
  const outside = mkdtempSync(join(tmpdir(), "codenomad-outside-"))
  const opened: string[] = []
  const dependencies = {
    openPath: async (path: string) => { opened.push(path); return "" },
    revealPath: () => undefined,
  }

  try {
    await openWorkspaceTarget("default", root, ".", undefined, dependencies)
    assert.deepEqual(opened, [root])
    await assert.rejects(openWorkspaceTarget("default", root, outside, undefined, dependencies), /outside the workspace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("opens local paths, leaving text files to the caller when asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-local-"))
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "notes.txt"), "héllo")
  writeFileSync(join(root, "clip.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
  // A multi-byte character cut by the 8 KiB sample is still text.
  writeFileSync(join(root, "long.txt"), "a".repeat(8191) + "é")
  const opened: string[] = []
  const dependencies = { openPath: async (path: string) => { opened.push(path); return "" }, revealPath: () => undefined }
  try {
    assert.equal(looksLikeText(join(root, "long.txt")), true)
    assert.equal(await openLocalPath(join(root, "docs"), true, dependencies), true)
    assert.equal(await openLocalPath(join(root, "clip.mp4"), true, dependencies), true)
    assert.equal(await openLocalPath(join(root, "notes.txt"), true, dependencies), false)
    assert.equal(await openLocalPath(join(root, "missing"), true, dependencies), false)
    assert.equal(await openLocalPath(join(root, "notes.txt"), false, dependencies), true)
    await assert.rejects(openLocalPath(join(root, "missing"), false, dependencies), /ENOENT/)
    await assert.rejects(openLocalPath("docs", false, dependencies), /absolute/)
    assert.deepEqual(opened.map(path => basename(path)), ["docs", "clip.mp4", "notes.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("edits Windows scripts and rejects executable default-open targets", () => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-executable-"))
  const script = join(root, "run.cmd")
  writeFileSync(script, "echo unsafe")
  try {
    assert.equal(defaultOpenMode(script, "win32"), "edit")
    const document = join(root, "notes.txt")
    writeFileSync(document, "safe")
    assert.equal(defaultOpenMode(document, "win32"), "open")
    const executable = join(root, "run.exe")
    writeFileSync(executable, "unsafe")
    assert.equal(defaultOpenMode(executable, "win32"), "choose")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("launches terminals in the selected directory without a shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-terminal-"))
  const nested = join(root, "nested")
  mkdirSync(nested)
  const launches: Array<{ command: string; args: readonly string[]; cwd: string }> = []
  const spawnProcess = (command: string, args: readonly string[], options: { cwd: string }) => {
    launches.push({ command, args, cwd: options.cwd })
    const child = new EventEmitter() as ChildProcess
    child.unref = () => child
    queueMicrotask(() => {
      child.emit("spawn")
      child.emit("exit", 0)
    })
    return child
  }

  try {
    await openWorkspaceTarget("terminal", root, "nested", undefined, {
      openPath: async () => "",
      revealPath: () => undefined,
      spawnProcess,
    })
    assert.equal(launches[0]?.cwd, nested)
    assert.equal(launches[0]?.args.includes(nested), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
