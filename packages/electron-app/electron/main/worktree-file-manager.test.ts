import assert from "node:assert/strict"
import test from "node:test"
import { authorizeOpenWorktree, parseWorktreeInventory, validateRegisteredDirectory } from "./worktree-file-manager"

test("parses exact NUL-delimited worktree records", () => {
  assert.deepEqual(
    parseWorktreeInventory(Buffer.from("worktree C:/repo\0HEAD abc\0branch refs/heads/main\0\0worktree C:/repo/wt\0HEAD def\0detached\0\0")),
    ["C:/repo", "C:/repo/wt"],
  )
})

test("rejects relative, control, UNC, and device paths before filesystem access", () => {
  for (const value of ["relative/path", "C:/bad\0path", "C:/bad:name", "C:/repo/../other", "C:/repo/NUL.txt", "C:/repo/trailing.", "\\\\server\\share", "//server/share", "\\\\?\\C:\\repo", "\\\\.\\pipe\\name"]) {
    assert.throws(() => validateRegisteredDirectory(value, "win32"))
  }
  assert.equal(validateRegisteredDirectory("C:/repo", "win32"), "C:/repo")
  assert.equal(validateRegisteredDirectory("/repo", "linux"), "/repo")
  assert.throws(() => validateRegisteredDirectory("/dev/null", "linux"))
})

test("revalidates authorization and inventory before opening", async () => {
  let authorizations = 0
  let inventories = 0
  const opened: string[] = []
  await authorizeOpenWorktree(
    { rootDirectory: "C:/repo", registeredDirectory: "C:/repo/wt", targetDirectory: "C:/repo/wt/apps/web" },
    {
      authorize: () => { authorizations++ },
      canonicalize: async (value) => value.replace("C:", "c:"),
      inventory: async () => { inventories++; return ["C:/repo", "C:/repo/wt"] },
      openPath: async (value) => { opened.push(value); return "" },
      isDirectory: async () => true,
      platform: "win32",
    },
  )
  assert.equal(authorizations, 3)
  assert.equal(inventories, 2)
  assert.deepEqual(opened, ["c:/repo/wt/apps/web"])
})

test("does not open when the second inventory no longer contains the target", async () => {
  let inventories = 0
  let opened = false
  await assert.rejects(authorizeOpenWorktree(
    { rootDirectory: "/repo", registeredDirectory: "/repo/wt", targetDirectory: "/repo/wt" },
    {
      authorize: () => {},
      canonicalize: async (value) => value,
      inventory: async () => ++inventories === 1 ? ["/repo", "/repo/wt"] : ["/repo"],
      openPath: async () => { opened = true; return "" },
      isDirectory: async () => true,
      platform: "linux",
    },
  ), /not registered/)
  assert.equal(opened, false)
})

test("requires the root itself to be an exact inventory member", async () => {
  await assert.rejects(authorizeOpenWorktree(
    { rootDirectory: "/repo", registeredDirectory: "/repo/wt", targetDirectory: "/repo/wt" },
    {
      authorize: () => {},
      canonicalize: async (value) => value,
      inventory: async () => ["/repo/wt"],
      openPath: async () => "",
      isDirectory: async () => true,
      platform: "linux",
    },
  ), /Workspace root is not registered/)
})

test("requires the logical target to be a directory", async () => {
  await assert.rejects(authorizeOpenWorktree(
    { rootDirectory: "/repo", registeredDirectory: "/repo/wt", targetDirectory: "/repo/wt/file.sh" },
    {
      authorize: () => {},
      canonicalize: async (value) => value,
      inventory: async () => ["/repo", "/repo/wt"],
      openPath: async () => assert.fail("A file must not be opened"),
      isDirectory: async () => false,
      platform: "linux",
    },
  ), /must be a directory/)
})
