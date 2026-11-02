import { For, createEffect, createSignal, onCleanup } from "solid-js"
import type { MissionPanelTask } from "../../../server/src/api-types"
import { missionTaskOrder } from "../../../server/src/missions/mission-task-order"

/** Stable topological order, including retired work; unrelated tasks never gain an edge.
 * The order the server pages compact maps in, for a map that holds all its tasks. */
export function orderMissionTasks(tasks: MissionPanelTask[]): MissionPanelTask[] {
  return missionTaskOrder(tasks)
}

/** Edges of a row whose other end is a task not shown: drawn as dashed stubs. */
export type MissionGraphOmitted = Map<string, { dependencies: number; dependents: number }>
/** A stub's length, and its lane: inside the first edge lane (`4`). */
const STUB = 8, STUB_LANE = 1.5

/** Lane area width, matched by `.mission-flow-linked` row padding in mission-graph.css. */
const MISSION_GRAPH_WIDTH = 30

/** Measured dependency rail: each edge leaves its source row's status icon and
 * enters its dependent's, so the icons are the graph's nodes. Both coordinates are
 * measured: the row/button padding between the lane area and the icon belongs to
 * the edge, in the SVG's own (possibly scaled or RTL-mirrored) user space. */
export function MissionGraph(props: { tasks: MissionPanelTask[]; list: HTMLUListElement; omitted?: MissionGraphOmitted }) {
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
    // Keyed lookups keep hundreds of rows and their edges linear.
    const byKey = new Map(points().map(point => [point.key, point]))
    const links = props.tasks.flatMap(task => task.blockedBy.flatMap(key => {
      const from = byKey.get(key)
      const to = byKey.get(task.key)
      return from && to ? [{ from, to }] : []
    }))
    const lastTarget = new Map<string, number>()
    for (const link of links) lastTarget.set(link.from.key, Math.max(lastTarget.get(link.from.key) ?? -Infinity, link.to.y))
    const sources = points().filter(point => lastTarget.has(point.key))
    const ends: number[] = []
    const lanes = new Map<string, number>()
    for (const source of sources) {
      const last = lastTarget.get(source.key)!
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
  // A dependency precedes its dependent in the display order: stubs to tasks not shown
  // rise from the row for its dependencies and fall for its dependents.
  const stubs = () => points().flatMap(point => {
    const omitted = props.omitted?.get(point.key)
    return ([["dependencies", -STUB], ["dependents", STUB]] as const).filter(([side]) => omitted?.[side])
      .map(([side, rise]) => ({ key: point.key, side, d: `M ${point.x} ${point.y} H ${STUB_LANE} V ${point.y + rise}` }))
  })
  const width = () => Math.ceil(Math.max(MISSION_GRAPH_WIDTH, ...points().map(point => point.x)))
  return <svg ref={svg} class="mission-graph" width={width()} height={height()} aria-hidden="true">
    <For each={edges()}>{edge => <path data-from={edge.from.key} data-to={edge.to.key}
      d={`M ${edge.from.x} ${edge.from.y} H ${edge.lane} V ${edge.to.y} H ${edge.to.x}`} />}</For>
    <For each={stubs()}>{stub => <path class="mission-graph-omitted" data-task={stub.key} data-omitted={stub.side} d={stub.d} />}</For>
  </svg>
}
