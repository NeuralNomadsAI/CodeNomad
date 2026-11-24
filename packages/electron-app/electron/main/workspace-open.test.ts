import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import test from "node:test"
import { execFileSync, type ChildProcess } from "node:child_process"
import { defaultOpenMode, editorCandidates, isLocalDiskPath, looksLikeText, openLocalPath, openWorkspaceTarget } from "./workspace-open"

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
    assert.equal(await looksLikeText(join(root, "long.txt")), true)
    assert.equal(await openLocalPath(join(root, "docs"), "text", dependencies), "opened")
    assert.equal(await openLocalPath(join(root, "clip.mp4"), "text", dependencies), "opened")
    assert.equal(await openLocalPath(join(root, "notes.txt"), "text", dependencies), "kept")
    // Text beyond the reader's 5 MiB limit opens with the system.
    writeFileSync(join(root, "big.txt"), "a".repeat(5 * 1024 * 1024 + 1))
    assert.equal(await openLocalPath(join(root, "big.txt"), "text", dependencies), "opened")
    opened.pop()
    assert.equal(await openLocalPath(join(root, "missing"), "text", dependencies), "missing")
    assert.equal(await openLocalPath(join(root, "clip.mp4"), "files", dependencies), "kept")
    assert.equal(await openLocalPath(join(root, "docs"), "files", dependencies), "opened")
    assert.equal(await openLocalPath(join(root, "notes.txt"), "none", dependencies), "opened")
    assert.equal(await openLocalPath(join(root, "missing"), "none", dependencies), "missing")
    // Off the local disks, the caller keeps the path unless it asked for the system.
    assert.equal(await openLocalPath("docs", "text", dependencies), "kept")
    await assert.rejects(openLocalPath("docs", "none", dependencies), /local disk/)
    assert.deepEqual(opened.map(path => basename(path)), ["docs", "clip.mp4", "docs", "notes.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("special files are never read or opened", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-fifo-"))
  const fifo = join(root, "pipe")
  execFileSync("mkfifo", [fifo])
  const dependencies = { openPath: async () => { throw new Error("opened") }, revealPath: () => undefined }
  try {
    assert.equal(await openLocalPath(fifo, "text", dependencies), "kept")
    await assert.rejects(openLocalPath(fifo, "none", dependencies), /files and folders/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("local paths exclude network shares and device namespaces", () => {
  for (const path of ["C:\\x", "c:/x"]) assert.equal(isLocalDiskPath(path, "win32"), true, path)
  for (const path of ["\\\\host\\share\\x", "/\\host\\share\\x", "//host/share", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "/x", "C:x"]) {
    assert.equal(isLocalDiskPath(path, "win32"), false, path)
  }
  assert.equal(isLocalDiskPath("/home/x", "linux"), true)
  assert.equal(isLocalDiskPath("//host/x", "linux"), false)
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
