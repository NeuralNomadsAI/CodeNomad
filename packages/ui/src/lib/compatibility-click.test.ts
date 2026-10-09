import assert from "node:assert/strict"
import { test } from "node:test"
import { suppressCompatibilityClick } from "./compatibility-click"

test("swallows only the single click following a touch menu selection", () => {
  const target = new EventTarget()
  suppressCompatibilityClick(target)
  let received = 0
  target.addEventListener("click", () => { received++ })
  const ghost = new Event("click", { cancelable: true })
  target.dispatchEvent(ghost)
  assert.equal(ghost.defaultPrevented, true)
  assert.equal(received, 0)
  target.dispatchEvent(new Event("click", { cancelable: true }))
  assert.equal(received, 1)
})

test("expires when no compatibility click follows", async () => {
  const target = new EventTarget()
  let received = 0
  target.addEventListener("click", () => { received++ })
  suppressCompatibilityClick(target, 5)
  await new Promise(resolve => setTimeout(resolve, 20))
  target.dispatchEvent(new Event("click", { cancelable: true }))
  assert.equal(received, 1)
})
