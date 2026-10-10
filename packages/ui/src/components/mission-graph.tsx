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

/** Lane area width, matched by `.mission-flow-linked` row padding in mission-graph.css. */
const MISSION_GRAPH_WIDTH = 30

/** Measured dependency rail: each edge leaves its source row's status icon and
 * enters its dependent's, so the icons are the graph's nodes. Both coordinates are
 * measured: the row/button padding between the lane area and the icon belongs to
 * the edge, in the SVG's own (possibly scaled or RTL-mirrored) user space. */
export function MissionGraph(props: { tasks: MissionTask[]; list: HTMLUListElement }) {
  let svg!: SVGSVGElement
  const [points, setPoints] = createSignal<Array<{ key: string; x: number; y: number }>>([])
  const [height, setHeight] = createSignal(0)
  createEffect(() => {
    const tasks = props.tasks
    const list = props.list
    const measure = () => {
      const bounds = list.getBoundingClientRect(), origin = svg.getBoundingClientRect()
      const scaleY = list.offsetHeight ? bounds.height / list.offsetHeight : 1
      const scaleX = list.offsetWidth ? bounds.width / list.offsetWidth : 1
      // Mirrored in RTL (mission-graph.css): user x = 0 is the SVG's right edge.
      const rtl = getComputedStyle(svg).direction === "rtl"
      const rows = new Map([...list.children].map(row => [(row as HTMLElement).dataset.taskKey, row]))
      setPoints(tasks.flatMap(task => {
        const anchor = rows.get(task.key)?.querySelector("[data-graph-anchor]")
        if (!anchor) return []
        const box = anchor.getBoundingClientRect()
        // The edge stops at the icon's inline-start side, never crossing the glyph.
        const x = (rtl ? origin.right - box.right : box.left - origin.left) / scaleX
        return [{ key: task.key, x: Math.max(MISSION_GRAPH_WIDTH, x), y: (box.top - bounds.top + box.height / 2) / scaleY }]
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
  const width = () => Math.ceil(Math.max(MISSION_GRAPH_WIDTH, ...points().map(point => point.x)))
  return <svg ref={svg} class="mission-graph" width={width()} height={height()} aria-hidden="true">
    <For each={edges()}>{edge => <path data-from={edge.from.key} data-to={edge.to.key}
      d={`M ${edge.from.x} ${edge.from.y} H ${edge.lane} V ${edge.to.y} H ${edge.to.x}`} />}</For>
  </svg>
}
