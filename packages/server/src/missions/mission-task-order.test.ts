import assert from "node:assert/strict"
import test from "node:test"
import { missionTaskOrder } from "./mission-task-order"

type Task = { key: string; blockedBy: string[] }

/** Rounds taken one at a time over the remaining tasks, as the order is defined. */
function rounds(tasks: readonly Task[]): Task[] {
  const remaining = new Map(tasks.map(task => [task.key, task]))
  const ordered: Task[] = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => !task.blockedBy.some(key => remaining.has(key)))
    if (!ready.length) { ordered.push(...remaining.values()); break }
    for (const task of ready) { ordered.push(task); remaining.delete(task.key) }
  }
  return ordered
}

test("the display order takes each round of ready tasks in map order, a cycle's tasks after, whatever the plan", () => {
  let seed = 7
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
  for (let plan = 0; plan < 300; plan++) {
    const size = 1 + Math.floor(random() * 60)
    const tasks: Task[] = Array.from({ length: size }, (_, index) => ({ key: `t${index}`, blockedBy: [] }))
    for (const task of tasks) {
      // Mostly earlier tasks, sometimes later ones (cycles), unknown keys and repeats.
      const count = Math.floor(random() * 4)
      for (let index = 0; index < count; index++) {
        const pick = random()
        task.blockedBy.push(pick < 0.08 ? "missing" : `t${Math.floor(random() * size)}`)
      }
    }
    const shuffled = [...tasks].sort(() => random() - 0.5)
    assert.deepEqual(missionTaskOrder(shuffled).map(task => task.key), rounds(shuffled).map(task => task.key), `plan ${plan}`)
  }
  // A chain of thousands stays linear: no round rescans the plan.
  const chain = Array.from({ length: 20_000 }, (_, index) => ({ key: `c${index}`, blockedBy: index ? [`c${index - 1}`] : [] })).reverse()
  const start = performance.now()
  assert.deepEqual(missionTaskOrder(chain).map(task => task.key).slice(0, 3), ["c0", "c1", "c2"])
  assert.ok(performance.now() - start < 2_000)
})
