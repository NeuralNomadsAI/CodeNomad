import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_REMOTE_PROJECT_RECENTS,
  mixRecents,
  normalizeRemoteProjectRecents,
  normalizeSideCarRecents,
  withSideCarRecent,
  withoutSideCarRecent,
  recentKey,
  withoutRemoteProjectRecent,
  withRemoteProjectRecent,
} from "./remote-project-recents.ts"
import { filterRecents } from "./recent-folder-display.ts"

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

describe("SideCar recent tabs", () => {
  it("keep only a SideCar's id and when it opened, newest first, without duplicates", () => {
    assert.deepEqual(normalizeSideCarRecents([
      { sidecarId: "docs", lastAccessed: 1, url: "https://127.0.0.1:3000/?token=secret" },
      { sidecarId: "wiki", lastAccessed: 3 },
      { sidecarId: "docs", lastAccessed: 9 },
      { sidecarId: "" }, null, "docs",
    ]), [{ sidecarId: "wiki", lastAccessed: 3 }, { sidecarId: "docs", lastAccessed: 1 }])
    const list = withSideCarRecent([{ sidecarId: "wiki", lastAccessed: 3 }], "docs", 10)
    assert.deepEqual(list, [{ sidecarId: "docs", lastAccessed: 10 }, { sidecarId: "wiki", lastAccessed: 3 }])
    assert.deepEqual(withSideCarRecent(list, "wiki", 11).map((entry) => entry.sidecarId), ["wiki", "docs"])
    assert.deepEqual(withoutSideCarRecent(list, "docs"), [{ sidecarId: "wiki", lastAccessed: 3 }])
  })

  it("mix with projects by date, named by configured SideCars, and are searched like them", () => {
    const mixed = mixRecents([{ path: "D:/app", lastAccessed: 5 }], [], [],
      [{ sidecarId: "docs", lastAccessed: 7 }, { sidecarId: "gone", lastAccessed: 9 }], [{ id: "docs", name: "Docs" }])
    assert.deepEqual(mixed, [
      { path: "docs", lastAccessed: 7, projectName: "Docs", sidecar: { sidecarId: "docs" } },
      { path: "D:/app", lastAccessed: 5 },
    ])
    assert.notEqual(recentKey(mixed[0]), recentKey({ path: "docs" }), "a SideCar never shares a folder's key")
    assert.deepEqual(filterRecents(mixed, "doc").map((entry) => entry.path), ["docs"])
    assert.deepEqual(filterRecents(mixed, "  ").length, 2)
  })
})