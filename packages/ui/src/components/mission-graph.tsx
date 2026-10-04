import { For, createEffect, createSignal, onCleanup } from "solid-js"
import type { MissionTask } from "../../../server/src/api-types"

/** Stable topological order, including retired work; unrelated tasks never gain an edge. */
export function orderMissionTasks(tasks: MissionTask[]): MissionTask[] {
  const remaining = new Map(tasks.map(task => [task.key, task]))
  const ordered: MissionTask[] = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => !task.blockedBy.some(key => remaining.has(key)))
    // Defensive display fallback for an incomplete or cyclic historical snapshot.
    if (!ready.length) { ordered.push(...remaining.values()); break }
    for (const task of ready) { ordered.push(task); remaining.delete(task.key) }
  }
  return ordered
}

/** Measured dependency rail: compact shared rows retain their exact anchors on resize. */
export function MissionGraph(props: { tasks: MissionTask[]; list: HTMLUListElement }) {
  const [points, setPoints] = createSignal<Array<{ key: string; x: number; y: number; status: string }>>([])
  const [height, setHeight] = createSignal(0)
  createEffect(() => {
    const tasks = props.tasks
    const list = props.list
    const measure = () => {
      const bounds = list.getBoundingClientRect()
      const scale = list.offsetHeight ? bounds.height / list.offsetHeight : 1
      const rows = new Map([...list.children].map(row => [(row as HTMLElement).dataset.taskKey, row]))
      setPoints(tasks.flatMap(task => {
        const heading = rows.get(task.key)?.querySelector(".mission-list-item") ?? rows.get(task.key)?.querySelector("h3")
        if (!heading) return []
        const box = heading.getBoundingClientRect()
        return [{ key: task.key, x: 38, y: (box.top - bounds.top + box.height / 2) / scale, status: task.status }]
      }))
      setHeight(list.offsetHeight)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const row of list.children) observer.observe(row)
    const frame = requestAnimationFrame(measure)
    onCleanup(() => { observer.disconnect(); cancelAnimationFrame(frame) })
  })
  const edges = () => {
    const links = props.tasks.flatMap(task => task.blockedBy.flatMap(key => {
      const from = points().find(point => point.key === key)
      const to = points().find(point => point.key === task.key)
      return from && to ? [{ from, to }] : []
    }))
    const sources = points().filter(point => links.some(link => link.from.key === point.key))
    const ends: number[] = []
    const lanes = new Map<string, number>()
    for (const source of sources) {
      const last = Math.max(...links.filter(link => link.from.key === source.key).map(link => link.to.y))
      const free = ends.findIndex(end => end < source.y)
      const lane = free < 0 ? ends.length : free
      ends[lane] = last
      lanes.set(source.key, lane)
    }
    // Buses stay to the side of the nodes: an edge must not visually connect
    // an unrelated intermediate task just because it occupies the same depth.
    return links.map(link => ({ ...link, lane: 5 + lanes.get(link.from.key)! * Math.min(8, 24 / Math.max(1, ends.length - 1)) }))
  }
  return <svg class="mission-graph" width="46" height={height()} aria-hidden="true">
    <For each={edges()}>{edge => <path data-from={edge.from.key} data-to={edge.to.key}
      d={`M ${edge.from.x} ${edge.from.y} H ${edge.lane} V ${edge.to.y} H ${edge.to.x}`} />}</For>
    <For each={points()}>{point => <g data-status={point.status}>
      <path class="mission-graph-tick" d={`M ${point.x} ${point.y} H 46`} />
      <rect x={point.x - 3} y={point.y - 3} width="6" height="6" />
    </g>}</For>
  </svg>
}
