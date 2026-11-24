import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { backendIdOf, backendScoped, instanceKey, isBackendId, LOCAL_BACKEND_ID, parseInstanceKey, projectScope } from "./backend-identity"

describe("backend instance identity", () => {
  it("keeps local workspace ids as instance keys and prefixes another backend's with ~", () => {
    const workspaceId = "6f1c1b6e-3c55-4b0e-9a0e-2f4f3cc7d1aa"
    assert.equal(instanceKey(LOCAL_BACKEND_ID, workspaceId), workspaceId)
    assert.equal(instanceKey("lab-vm", workspaceId), `lab-vm~${workspaceId}`)
    assert.deepEqual(parseInstanceKey(`lab-vm~${workspaceId}`), { backendId: "lab-vm", workspaceId })
    assert.deepEqual(parseInstanceKey(workspaceId), { backendId: LOCAL_BACKEND_ID, workspaceId })
    assert.deepEqual(parseInstanceKey("local~kept-as-is"), { backendId: LOCAL_BACKEND_ID, workspaceId: "local~kept-as-is" })
  })

  it("never puts a separator in a key that instance-keyed maps split at the first colon", () => {
    const key = instanceKey("lab_2", "w1")
    const sessionKey = `${key}:session`
    assert.equal(sessionKey.slice(0, sessionKey.indexOf(":")), key)
    for (const id of ["a:b", "", "a~b", "a/b", "a\0b", "x".repeat(65)]) {
      assert.equal(isBackendId(id), false, id)
      assert.throws(() => instanceKey(id, "w1"))
    }
  })

  it("identifies a project by backend and folder, the folder alone for the local backend", () => {
    assert.equal(projectScope({ folder: "/repo" }), "/repo")
    assert.equal(projectScope({ folder: "/repo", backendId: LOCAL_BACKEND_ID }), "/repo")
    assert.equal(projectScope({ folder: "/repo", backendId: "lab" }), "lab~/repo")
    assert.notEqual(projectScope({ folder: "/repo", backendId: "lab" }), projectScope({ folder: "/repo", backendId: "other" }))
    assert.equal(backendScoped(undefined, "C:/Code"), "C:/Code")
    assert.equal(backendIdOf({}), LOCAL_BACKEND_ID)
    assert.equal(backendIdOf({ backendId: "lab" }), "lab")
  })
})
