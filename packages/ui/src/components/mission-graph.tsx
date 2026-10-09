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

/** Rail width, matched by `.mission-flow-linked` row padding in mission-graph.css. */
const MISSION_GRAPH_WIDTH = 30

/** Measured dependency rail: each edge leaves its source row's status icon and
 * enters its dependent's, so the icons are the graph's nodes. */
export function MissionGraph(props: { tasks: MissionTask[]; list: HTMLUListElement }) {
  const [points, setPoints] = createSignal<Array<{ key: string; y: number }>>([])
  const [height, setHeight] = createSignal(0)
  createEffect(() => {
    const tasks = props.tasks
    const list = props.list
    const measure = () => {
      const bounds = list.getBoundingClientRect()
      const scale = list.offsetHeight ? bounds.height / list.offsetHeight : 1
      const rows = new Map([...list.children].map(row => [(row as HTMLElement).dataset.taskKey, row]))
      setPoints(tasks.flatMap(task => {
        const anchor = rows.get(task.key)?.querySelector("[data-graph-anchor]")
        if (!anchor) return []
        const box = anchor.getBoundingClientRect()
        return [{ key: task.key, y: (box.top - bounds.top + box.height / 2) / scale }]
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
      // A lane ending at this very row belongs to an edge into this source: chains stay on one straight rail.
      const free = ends.findIndex(end => end <= source.y)
      const lane = free < 0 ? ends.length : free
      ends[lane] = last
      lanes.set(source.key, lane)
    }
    // Buses stay to the side of the rows: an edge must not visually connect
    // an unrelated intermediate task just because it occupies the same depth.
    return links.map(link => ({ ...link, lane: 4 + lanes.get(link.from.key)! * Math.min(6, 20 / Math.max(1, ends.length - 1)) }))
  }
  const x = MISSION_GRAPH_WIDTH
  return <svg class="mission-graph" width={x} height={height()} aria-hidden="true">
    <For each={edges()}>{edge => <path data-from={edge.from.key} data-to={edge.to.key}
      d={`M ${x} ${edge.from.y} H ${edge.lane} V ${edge.to.y} H ${x}`} />}</For>
  </svg>
}
