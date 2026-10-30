import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import { createMissionViewFence, createReportedChanges } from "./mission-view-fence"

test("a value's first report keeps the captured view; a different reported value fences it", () => {
  createRoot(dispose => {
    const [reported, setReported] = createSignal<string>()
    const changes = createReportedChanges(reported)
    const capture = createMissionViewFence(() => JSON.stringify(["instance", "directory", changes()]), () => true)
    const beforeFirstRead = capture()
    setReported("project")
    assert.equal(beforeFirstRead(), true, "the first read reports the project the view already showed")
    setReported(undefined); setReported("project")
    assert.equal(beforeFirstRead(), true, "a cleared read keeps the reported project")
    setReported("other")
    assert.equal(beforeFirstRead(), false, "another reported project is another view")
    const afterChange = capture()
    setReported("project")
    assert.equal(afterChange(), false, "returning to an earlier project is still a change (ABA)")
    dispose()
  })
})

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
