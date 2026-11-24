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
    session("unregistered", "/repo/.worktrees/unregistered"),
    { ...session("migrated", "/repo"), projectID: "global" },
  ]
  const selected = selectWorkspaceSessionFamilies(inventory, "/repo", [
    { slug: "root", directory: "/repo", kind: "root" },
    { slug: "feature", directory: "/separate-worktrees/feature", kind: "worktree" },
  ])
  assert.deepEqual(selected.map(({ id }) => id), ["root", "worktree", "child", "migrated"])
})

it("retains the ancestry and siblings needed by a local family member", () => {
  const inventory = [
    session("parent", "/former-directory"),
    session("local-child", "/repo", "parent"),
    session("sibling", "/former-directory", "parent"),
    session("unrelated", "/former-directory"),
  ]
  assert.deepEqual(selectWorkspaceSessionFamilies(inventory, "/repo", []).map(({ id }) => id), [
    "parent", "local-child", "sibling",
  ])
})

it("matches the service-side paths of WSL worktrees without treating a shared project ID as ownership", () => {
  const inventory = [session("owned", "/home/me/repo-feature"), session("clone", "/home/me/clone")]
  const selected = selectWorkspaceSessionFamilies(inventory, "D:\\repo", [
    { slug: "feature", directory: "D:\\repo-feature", serviceDirectory: "/home/me/repo-feature", kind: "worktree" },
  ])
  assert.deepEqual(selected.map(({ id }) => id), ["owned"])
})
