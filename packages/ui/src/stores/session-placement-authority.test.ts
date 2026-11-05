import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { captureSessionPlacementAuthority, sessions, setSessions, withSession } from "./session-state"
import type { Session } from "../types/session"

let sequence = 0
const ids: string[] = []
afterEach(() => setSessions(previous => { const next = new Map(previous); for (const id of ids.splice(0)) next.delete(id); return next }))
function owner() {
  const id = `placement-owner-${++sequence}`; ids.push(id)
  const row = { id: "ses_s", instanceId: id, title: "Known", parentId: null, status: "idle", time: { created: 1, updated: 1 },
    location: { directory: "C:/é %25/native", workspaceID: "native-one" } } as Session
  setSessions(previous => new Map(previous).set(id, new Map([[row.id, row], ["sibling", { ...row, id: "sibling" }]])))
  return { id, row }
}
for (const writer of ["withSession", "setSessions"] as const) for (const field of ["directory", "workspaceID"] as const) test(`${writer} ${field} ABA is irreversible at accepted publication`, () => {
  const { id, row } = owner(), current = captureSessionPlacementAuthority(id, row.id)
  for (const location of [{ ...row.location, [field]: "other" }, row.location]) {
    if (writer === "withSession") withSession(id, row.id, session => { session.location = { ...location } })
    else setSessions(previous => {
      previous.get(id)!.set(row.id, { ...previous.get(id)!.get(row.id)!, location: { ...location } })
      return new Map(previous)
    })
    assert.equal(current(), false)
  }
  assert.equal(captureSessionPlacementAuthority(id, row.id)(), true)
})
test("equal placement object/HTTP replacement, metadata and a sibling transition preserve its captured owner", () => {
  const { id, row } = owner(), current = captureSessionPlacementAuthority(id, row.id)
  withSession(id, row.id, session => { session.location = { ...row.location }; session.title = "New metadata" })
  setSessions(previous => new Map(previous).set(id, new Map([[row.id, { ...row, location: { ...row.location } }],
    ["sibling", { ...row, id: "sibling", location: { directory: "/elsewhere" } }]])))
  assert.equal(current(), true)
})
test("removal and same-ID reinsertion at the same placement cannot restore an older owner", () => {
  const { id, row } = owner(), current = captureSessionPlacementAuthority(id, row.id)
  setSessions(previous => { previous.get(id)!.delete(row.id); return new Map(previous) })
  assert.equal(current(), false)
  setSessions(previous => { previous.get(id)!.set(row.id, row); return new Map(previous) })
  assert.equal(current(), false)
  assert.equal(captureSessionPlacementAuthority(id, row.id)(), true)
})
test("a rejected withSession edit preserves the published placement owner", () => {
  const { id, row } = owner(), current = captureSessionPlacementAuthority(id, row.id)
  withSession(id, row.id, session => { session.location = { directory: "/rejected" }; return false })
  assert.equal(sessions().get(id)!.get(row.id)!.location.directory, row.location.directory)
  assert.equal(current(), true)
})
