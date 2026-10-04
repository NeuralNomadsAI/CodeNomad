import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import { createMissionViewFence } from "./mission-view-fence"

test("originating Mission view fences identity/activity ABA and disposal, without cancelling native work", () => {
  createRoot(dispose => {
    const [snapshot, setSnapshot] = createSignal({ identity: "instance/directory/project", revision: 1 })
    const identity = () => snapshot().identity
    const setIdentity = (value: string) => setSnapshot({ identity: value, revision: snapshot().revision + 1 })
    const [active, setActive] = createSignal(true)
    const capture = createMissionViewFence(identity, active)
    const original = capture()
    assert.equal(original(), true)
    setIdentity("instance/directory/project")
    assert.equal(original(), true, "equivalent identity notifications are not a new view")
    setIdentity("other"); setIdentity("instance/directory/project")
    assert.equal(original(), false)
    const resumed = capture()
    setActive(false); setActive(true)
    assert.equal(resumed(), false)
    const current = capture()
    assert.equal(current(), true)
    dispose(); assert.equal(current(), false)
  })
})
