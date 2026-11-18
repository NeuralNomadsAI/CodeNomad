import assert from "node:assert/strict"
import { it } from "node:test"
import type { SessionInfo } from "@opencode/client"
import { selectWorkspaceSessionFamilies } from "./workspace-session-scope.ts"

function session(id: string, directory: string, parentID?: string): SessionInfo {
  return { id, projectID: "shared-native-project", parentID, location: { directory } } as SessionInfo
}

it("scopes a native project to the opened local repository and its registered worktrees", () => {
  const inventory = [
    session("root", "/repo"),
    session("worktree", "/separate-worktrees/feature"),
    session("child", "/separate-worktrees/feature", "worktree"),
    session("clone", "/other-clone"),
    session("clone-child", "/other-clone", "clone"),
    session("prefix", "/repo-copy"),
    // Inside the opened folder the root checkout owns it, as the proxy does.
    session("unregistered", "/repo/.worktrees/unregistered"),
    session("unregistered-outside", "/repo-worktrees/unregistered"),
    { ...session("migrated", "/repo"), projectID: "global" },
  ]
  const selected = selectWorkspaceSessionFamilies(inventory, "/repo", [
    { slug: "root", directory: "/repo", kind: "root" },
    { slug: "feature", directory: "/separate-worktrees/feature", kind: "worktree" },
  ])
  assert.deepEqual(selected.map(({ id }) => id), ["root", "worktree", "child", "unregistered", "migrated"])
})

it("never selects family members located elsewhere for a local member", () => {
  const inventory = [
    session("parent", "/former-directory"),
    session("local-child", "/repo", "parent"),
    session("sibling", "/former-directory", "parent"),
    session("unrelated", "/former-directory"),
  ]
  assert.deepEqual(selectWorkspaceSessionFamilies(inventory, "/repo", []).map(({ id }) => id), ["local-child"])
})

it("owns exactly what the workspace proxy serves: subfolders of owned checkouts, never a prefix or an exact-folder entry's subfolders", () => {
  const inventory = [
    session("package", "/repo/packages/ui"),
    session("worktree-package", "/separate-worktrees/feature/packages/ui"),
    session("prefix", "/repo-copy/packages/ui"),
    session("clone", "/other-clone/packages/ui"),
    session("case", "C:/Repo/Packages", undefined),
  ]
  assert.deepEqual(selectWorkspaceSessionFamilies(inventory, "/repo", [
    { slug: "root", directory: "/repo", kind: "root" },
    { slug: "feature", directory: "/separate-worktrees/feature", kind: "worktree" },
  ]).map(({ id }) => id), ["package", "worktree-package"])
  assert.deepEqual(selectWorkspaceSessionFamilies(inventory, "c:\\repo", [{ slug: "root", directory: "c:\\repo", kind: "root" }])
    .map(({ id }) => id), ["case"], "Windows paths compare case-insensitively")
  const exact = [session("folder", "/plain"), session("below", "/plain/sub")]
  assert.deepEqual(selectWorkspaceSessionFamilies(exact, "/plain", [{ slug: "root", directory: "/plain", kind: "root", directoryOnly: true }])
    .map(({ id }) => id), ["folder"], "an exact-folder authority owns no subfolder")
})

it("matches the service-side paths of WSL worktrees without treating a shared project ID as ownership", () => {
  const inventory = [session("owned", "/home/me/repo-feature"), session("owned-package", "/home/me/repo-feature/pkg"), session("clone", "/home/me/clone")]
  const selected = selectWorkspaceSessionFamilies(inventory, "D:\\repo", [
    { slug: "feature", directory: "D:\\repo-feature", serviceDirectory: "/home/me/repo-feature", kind: "worktree" },
  ])
  assert.deepEqual(selected.map(({ id }) => id), ["owned", "owned-package"])
})
