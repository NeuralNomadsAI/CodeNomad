import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { filterProjectScopedSessions, normalizeSessionDirectory } from "./session-list-options.ts"

describe("session directory mapping", () => {
  it("uses location.directory and normalizes Windows paths", () => {
    assert.equal(normalizeSessionDirectory("C:\\Repo\\Feature\\"), "c:/repo/feature")
    const sessions = [
      { id: "location-wins", location: { directory: "C:/repo/feature" } },
      { id: "root", location: { directory: "C:/repo" } },
    ]
    assert.deepEqual(
      filterProjectScopedSessions(sessions, ["c:\\REPO\\FEATURE"]).map((session) => session.id),
      ["location-wins"],
    )
  })
})
