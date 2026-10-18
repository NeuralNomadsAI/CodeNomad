import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GIT_CHANGE_ROW_LIMIT, buildGitChangeWindow, sameGitChangeWindow } from "./git-change-window.ts"
import type { GitChangeListItem } from "./types.ts"

const items = (count: number): GitChangeListItem[] => Array.from({ length: count }, (_, index) => {
  const path = `src/file-${String(index).padStart(4, "0")}.ts`
  return { id: `unstaged:${path}`, path, section: "unstaged", status: "modified", additions: 1, deletions: 0, displayName: path, parentPath: "src" }
})
const none = new Set<string>()

describe("buildGitChangeWindow", () => {
  it("renders small sections whole, as the same array", () => {
    const list = items(GIT_CHANGE_ROW_LIMIT)
    const window = buildGitChangeWindow(list, GIT_CHANGE_ROW_LIMIT, none)
    assert.equal(window.rows, list)
    assert.deepEqual({ total: window.total, hidden: window.hidden, nextReveal: window.nextReveal, first: window.firstHiddenId },
      { total: GIT_CHANGE_ROW_LIMIT, hidden: 0, nextReveal: 0, first: null })
  })

  it("bounds large sections and reveals the next batch in order", () => {
    const list = items(2 * GIT_CHANGE_ROW_LIMIT + 50)
    const first = buildGitChangeWindow(list, GIT_CHANGE_ROW_LIMIT, none)
    assert.deepEqual(first.rows, list.slice(0, GIT_CHANGE_ROW_LIMIT))
    assert.deepEqual([first.total, first.hidden, first.nextReveal, first.nextLimit], [list.length, GIT_CHANGE_ROW_LIMIT + 50, GIT_CHANGE_ROW_LIMIT, 2 * GIT_CHANGE_ROW_LIMIT])
    assert.equal(first.firstHiddenId, list[GIT_CHANGE_ROW_LIMIT].id)
    const second = buildGitChangeWindow(list, first.nextLimit, none)
    assert.deepEqual([second.rows.length, second.hidden, second.nextReveal, second.nextLimit], [2 * GIT_CHANGE_ROW_LIMIT, 50, 50, list.length])
    assert.equal(buildGitChangeWindow(list, second.nextLimit, none).rows, list)
  })

  it("renders pinned rows beyond the bound after it, without counting them as hidden or as the next batch", () => {
    const list = items(3 * GIT_CHANGE_ROW_LIMIT)
    const near = list[GIT_CHANGE_ROW_LIMIT], far = list[3 * GIT_CHANGE_ROW_LIMIT - 1]
    const window = buildGitChangeWindow(list, GIT_CHANGE_ROW_LIMIT, new Set([far.id, near.id, list[3].id, "staged:elsewhere"]))
    assert.deepEqual(window.rows.slice(GIT_CHANGE_ROW_LIMIT), [near, far], "pinned rows keep list order")
    assert.equal(window.rows.length, GIT_CHANGE_ROW_LIMIT + 2)
    assert.equal(window.hidden, list.length - GIT_CHANGE_ROW_LIMIT - 2)
    assert.equal(window.firstHiddenId, list[GIT_CHANGE_ROW_LIMIT + 1].id, "focus goes to the first row the reveal adds")
    assert.equal(window.nextReveal, GIT_CHANGE_ROW_LIMIT)
    assert.equal(window.nextLimit, 2 * GIT_CHANGE_ROW_LIMIT + 1, "the next batch skips the already rendered pinned row")
  })
})

describe("sameGitChangeWindow", () => {
  it("compares rendered rows by identity and every counter", () => {
    const list = items(GIT_CHANGE_ROW_LIMIT + 10)
    const window = buildGitChangeWindow(list, GIT_CHANGE_ROW_LIMIT, none)
    assert.ok(sameGitChangeWindow(window, buildGitChangeWindow([...list], GIT_CHANGE_ROW_LIMIT, new Set())))
    assert.ok(!sameGitChangeWindow(window, buildGitChangeWindow(list.map(item => ({ ...item })), GIT_CHANGE_ROW_LIMIT, none)))
    assert.ok(!sameGitChangeWindow(window, buildGitChangeWindow(list, GIT_CHANGE_ROW_LIMIT, new Set([list.at(-1)!.id]))))
  })
})
