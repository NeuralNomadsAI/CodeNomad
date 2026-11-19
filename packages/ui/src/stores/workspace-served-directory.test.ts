import assert from "node:assert/strict"
import { it } from "node:test"
import { isWorkspaceServedDirectory } from "./workspace-served-directory.ts"

it("serves what the workspace proxy serves: subfolders of owned checkouts, never a prefix, a clone or an exact-folder entry's subfolders", () => {
  const worktrees = [
    { slug: "root", directory: "/repo", kind: "root" },
    { slug: "feature", directory: "/separate-worktrees/feature", kind: "worktree" },
  ] as const
  const served = (directory: string) => isWorkspaceServedDirectory(directory, "/repo", [...worktrees])
  assert.deepEqual(["/repo", "/repo/packages/ui", "/separate-worktrees/feature/pkg", "/repo-copy", "/other-clone/repo"].map(served),
    [true, true, true, false, false])
  assert.equal(isWorkspaceServedDirectory("C:/Repo/Packages", "c:\\repo", [{ slug: "root", directory: "c:\\repo", kind: "root" }]), true,
    "Windows paths compare case-insensitively")
  assert.equal(isWorkspaceServedDirectory("/plain/sub", "/plain", [{ slug: "root", directory: "/plain", kind: "root", directoryOnly: true }]), false)
  assert.equal(isWorkspaceServedDirectory("/home/me/repo-feature/pkg", "D:\\repo", [
    { slug: "feature", directory: "D:\\repo-feature", serviceDirectory: "/home/me/repo-feature", kind: "worktree" },
  ]), true, "WSL service paths")
})
