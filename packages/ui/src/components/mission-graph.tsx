import { For, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionPanelTask } from "../../../server/src/api-types"
import { missionTaskOrder } from "../../../server/src/missions/mission-task-order"
import type { VirtualizerHandle } from "virtua/solid"

/** Stable topological order, including retired work; unrelated tasks never gain an edge.
 * The order the server pages compact maps in, for a map that holds all its tasks. */
export function orderMissionTasks(tasks: MissionPanelTask[]): MissionPanelTask[] {
  return missionTaskOrder(tasks)
}

/** Edges of a row whose other end is a task not shown: drawn as dashed stubs. */
export type MissionGraphOmitted = Map<string, { dependencies: number; dependents: number }>
/** A stub's length, and its lane: inside the first edge lane (`FIRST_LANE`). */
const STUB = 8, STUB_LANE = 10

/** Lane area width the rows' nesting indent and expander column hold (mission-graph.css); more
 * lanes widen it by `LANE_STEP` each, the rows moving over by the excess (`onExtra`). */
// The first lane runs under the Mission row's chevron, clear of the panel edge.
const MISSION_GRAPH_WIDTH = 30, FIRST_LANE = 14, LANE_STEP = 6, LANE_MARGIN = 10

/** Measured dependency rail: each edge leaves its source row's status icon and
 * enters its dependent's, so the icons are the graph's nodes. Both coordinates are
 * measured: the row/button padding between the lane area and the icon belongs to
 * the edge, in the SVG's own (possibly scaled or RTL-mirrored) user space. */
export function MissionGraph(props: { tasks: MissionPanelTask[]; list: HTMLUListElement; omitted?: MissionGraphOmitted
  /** The width beyond `MISSION_GRAPH_WIDTH` the lanes need, which the rows' indent adds. */
  onExtra?: (pixels: number) => void
  virtualizer?: VirtualizerHandle; layoutVersion?: number }) {
  let svg!: SVGSVGElement
  const [points, setPoints] = createSignal<Array<{ key: string; x: number; y: number }>>([], {
    equals: (previous, next) => previous.length === next.length && previous.every((point, index) =>
      point.key === next[index].key && point.x === next[index].x && point.y === next[index].y),
  })
  const [height, setHeight] = createSignal(0)
  let anchorX = MISSION_GRAPH_WIDTH
  createEffect(() => {
    props.layoutVersion
    const tasks = props.tasks
    const list = props.list
    const measure = () => {
      const bounds = list.getBoundingClientRect(), origin = svg.getBoundingClientRect()
      const scaleY = list.offsetHeight ? bounds.height / list.offsetHeight : 1
      const scaleX = list.offsetWidth ? bounds.width / list.offsetWidth : 1
      // Mirrored in RTL (mission-graph.css): user x = 0 is the SVG's right edge.
      const rtl = getComputedStyle(svg).direction === "rtl"
      const rows = new Map([...list.querySelectorAll<HTMLElement>("[data-task-key]")].map(row => [row.dataset.taskKey, row]))
      const sample = list.querySelector("[data-graph-anchor]")?.getBoundingClientRect()
      if (sample?.width) anchorX = (rtl ? origin.right - sample.right : sample.left - origin.left) / scaleX
      setPoints(tasks.flatMap((task, index) => {
        // Offscreen rows use Virtua's measured/estimated layout; rails never require
        // mounting every task or fetching an unread dependency's task body.
        if (props.virtualizer) return [{ key: task.key, x: Math.max(MISSION_GRAPH_WIDTH, anchorX),
          y: props.virtualizer.getItemOffset(index) + props.virtualizer.getItemSize(index) / 2 }]
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
    remeasure = () => requestAnimationFrame(measure)
    onCleanup(() => { observer.disconnect(); cancelAnimationFrame(frame) })
  })
  let remeasure: (() => void) | undefined
  const edges = createMemo(() => {
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
    // Each lane keeps its own step, so many lanes widen the rail rather than merge.
    return { lanes: ends.length, links: links.map(link => ({ ...link, lane: FIRST_LANE + lanes.get(link.from.key)! * LANE_STEP })) }
  })
  // Lanes beyond the indent's room push the rows over; their icons move, so measure again.
  const extra = createMemo(() => Math.max(0, FIRST_LANE + Math.max(0, edges().lanes - 1) * LANE_STEP + LANE_MARGIN - MISSION_GRAPH_WIDTH))
  createEffect(() => { props.onExtra?.(extra()); remeasure?.() })
  // A dependency precedes its dependent in the display order: stubs to tasks not shown
  // rise from the row for its dependencies and fall for its dependents.
  const stubs = () => points().flatMap(point => {
    const omitted = props.omitted?.get(point.key)
    return ([["dependencies", -STUB], ["dependents", STUB]] as const).filter(([side]) => omitted?.[side])
      .map(([side, rise]) => ({ key: point.key, side, d: `M ${point.x} ${point.y} H ${STUB_LANE} V ${point.y + rise}` }))
  })
  const width = () => Math.ceil(Math.max(MISSION_GRAPH_WIDTH, ...points().map(point => point.x)))
  // Retain each existing rail's DOM node as pages arrive or measured coordinates change.
  const byEdge = createMemo(() => new Map(edges().links.map(edge => [JSON.stringify([edge.from.key, edge.to.key]), edge])))
  const edgeKeys = createMemo(() => [...byEdge().keys()])
  return <svg ref={svg} class="mission-graph" width={width()} height={height()} aria-hidden="true">
    <For each={edgeKeys()}>{key => {
      const edge = () => byEdge().get(key)!
      return <path data-from={edge().from.key} data-to={edge().to.key}
        d={`M ${edge().from.x} ${edge().from.y} H ${edge().lane} V ${edge().to.y} H ${edge().to.x}`} />
    }}</For>
    <For each={stubs()}>{stub => <path class="mission-graph-omitted" data-task={stub.key} data-omitted={stub.side} d={stub.d} />}</For>
  </svg>
}
