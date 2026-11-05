import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_REMOTE_PROJECT_RECENTS,
  mixRecents,
  normalizeRemoteProjectRecents,
  recentKey,
  withoutRemoteProjectRecent,
  withRemoteProjectRecent,
} from "./remote-project-recents.ts"

describe("remote project recents", () => {
  it("normalizes saved entries: valid, distinct, bounded and newest first", () => {
    const saved = [
      { profileId: "a", folder: "/one", lastAccessed: 1 },
      { profileId: "a", folder: "/one", lastAccessed: 9 },
      { profileId: "b", folder: "/two", projectName: " Two ", lastAccessed: 5 },
      { profileId: "", folder: "/x" },
      { profileId: "c" },
      "junk",
      { profileId: "c", folder: "/three", password: "never kept" },
    ]
    assert.deepEqual(normalizeRemoteProjectRecents(saved), [
      { profileId: "b", folder: "/two", projectName: "Two", lastAccessed: 5 },
      { profileId: "a", folder: "/one", lastAccessed: 1 },
      { profileId: "c", folder: "/three", lastAccessed: 0 },
    ])
    assert.deepEqual(normalizeRemoteProjectRecents({}), [])
    const many = Array.from({ length: 30 }, (_, index) => ({ profileId: "a", folder: `/${index}`, lastAccessed: index }))
    assert.equal(normalizeRemoteProjectRecents(many).length, MAX_REMOTE_PROJECT_RECENTS)
  })

  it("moves a reopened project first and keeps its known name", () => {
    const list = [
      { profileId: "a", folder: "/one", projectName: "One", lastAccessed: 1 },
      { profileId: "a", folder: "/two", lastAccessed: 2 },
    ]
    assert.deepEqual(withRemoteProjectRecent(list, { profileId: "a", folder: "/one" }, 10), [
      { profileId: "a", folder: "/one", projectName: "One", lastAccessed: 10 },
      { profileId: "a", folder: "/two", lastAccessed: 2 },
    ])
  })

  it("forgets one project, or every project of a removed server", () => {
    const list = [
      { profileId: "a", folder: "/one", lastAccessed: 1 },
      { profileId: "a", folder: "/two", lastAccessed: 2 },
      { profileId: "b", folder: "/one", lastAccessed: 3 },
    ]
    assert.deepEqual(withoutRemoteProjectRecent(list, "a", "/one").map(recentFolder), ["a:/two", "b:/one"])
    assert.deepEqual(withoutRemoteProjectRecent(list, "a").map(recentFolder), ["b:/one"])
  })

  it("mixes this computer's folders with projects of saved servers only, newest first", () => {
    const local = [{ path: "/local", lastAccessed: 5 }, { path: "/older", lastAccessed: 1 }]
    const remote = [
      { profileId: "box", folder: "/srv", projectName: "Srv", lastAccessed: 3 },
      { profileId: "gone", folder: "/lost", lastAccessed: 9 },
    ]
    const mixed = mixRecents(local, remote, [{ id: "box", name: "Box" }])
    assert.deepEqual(mixed.map((entry) => entry.path), ["/local", "/srv", "/older"])
    assert.deepEqual(mixed[1].remote, { profileId: "box", serverName: "Box" })
    assert.notEqual(recentKey({ path: "/srv" }), recentKey(mixed[1]))
    assert.deepEqual(mixRecents(local, [], []), local)
  })
})

function recentFolder(entry: { profileId: string; folder: string }) {
  return `${entry.profileId}:${entry.folder}`
}
