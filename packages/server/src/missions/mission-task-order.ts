// Shared with the UI: keep it free of Node modules.

/** A map's tasks in display order: stable topological order, retired work included.
 * Rounds take every task whose dependencies (among the map's tasks) are taken, each
 * round in map order; tasks a cycle keeps from any round follow, in map order. Linear in
 * tasks and dependencies, so the server pages any plan in the order the tree shows. */
export function missionTaskOrder<T extends { key: string; blockedBy: readonly string[] }>(tasks: readonly T[]): T[] {
  const index = new Map<string, number>()
  tasks.forEach((task, position) => { if (!index.has(task.key)) index.set(task.key, position) })
  const unique = tasks.filter((task, position) => index.get(task.key) === position)
  const pending = new Map<string, number>(), dependents = new Map<string, string[]>()
  for (const task of unique) {
    const deps = [...new Set(task.blockedBy)].filter(key => index.has(key))
    pending.set(task.key, deps.length)
    for (const key of deps) {
      const list = dependents.get(key)
      if (list) list.push(task.key)
      else dependents.set(key, [task.key])
    }
  }
  // A task's round is one past its latest dependency's; roots are round 0.
  const round = new Map<string, number>()
  let ready = unique.filter(task => pending.get(task.key) === 0).map(task => task.key)
  for (let level = 0; ready.length; level++) {
    const next: string[] = []
    for (const key of ready) {
      round.set(key, level)
      for (const dependent of dependents.get(key) ?? []) {
        const left = pending.get(dependent)! - 1
        pending.set(dependent, left)
        if (left === 0) next.push(dependent)
      }
    }
    ready = next
  }
  const position = (task: T) => index.get(task.key)!
  const ordered = unique.filter(task => round.has(task.key))
    .sort((left, right) => round.get(left.key)! - round.get(right.key)! || position(left) - position(right))
  return [...ordered, ...unique.filter(task => !round.has(task.key))]
}
