import { For, Index, Show, createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import type { VirtualChunkViewport } from "./virtual-chunk-viewport"

/** Provided per Virtua instance by `VirtualFollowList`; lists outside it render in full. */
export const VirtualChunkContext = createContext<VirtualChunkViewport>()

/** Items per chunk. A list of at most one chunk always renders in full. */
export const VIRTUAL_CHUNK_SIZE = 32
const ESTIMATED_ITEM_HEIGHT_PX = 48
const MEASURED_HEIGHT_LIMIT = 20_000

// Measured heights outlive row remounts (window paging, session switches), so a
// placeholder keeps the exact geometry its chunk had and restores stay stable.
const measuredHeights = new Map<string, number>()

function rememberHeight(key: string, height: number) {
  measuredHeights.delete(key)
  measuredHeights.set(key, height)
  if (measuredHeights.size > MEASURED_HEIGHT_LIMIT) measuredHeights.delete(measuredHeights.keys().next().value!)
}

interface VirtualChunkListProps<T> {
  each: readonly T[]
  /** Owner identity for measured heights, e.g. instance/session/message and list role. */
  cacheKey: string
  itemKey: (item: T) => string
  /** Keyed by item identity (`For`) instead of position (`Index`). */
  keyed?: boolean
  /** Keeps an item's chunk (and its neighbors) rendered regardless of distance, e.g. a navigation target. */
  pinned?: (item: T) => boolean
  /** Extra chunk class, for list contexts that are not flex columns. */
  class?: string
  children: (item: Accessor<T>) => JSX.Element
}

/**
 * Renders a long list in fixed-size chunks; chunks away from the viewport are
 * replaced by placeholders of their measured (or estimated) height. Rendered
 * chunks keep focus, pinned items and their DOM order.
 */
export default function VirtualChunkList<T>(props: VirtualChunkListProps<T>) {
  const viewport = useContext(VirtualChunkContext)
  const chunks = createMemo(() => {
    const items = props.each
    const result: T[][] = []
    for (let start = 0; start < items.length; start += VIRTUAL_CHUNK_SIZE) result.push(items.slice(start, start + VIRTUAL_CHUNK_SIZE))
    return result
  })
  const virtualized = () => Boolean(viewport) && chunks().length > 1
  // A pinned item also keeps its neighbors rendered, so navigation lands among
  // measured heights rather than estimates that resolve after the scroll.
  const pinnedChunks = createMemo(() => {
    const pinned = new Set<number>()
    if (!props.pinned || !virtualized()) return pinned
    chunks().forEach((chunk, index) => {
      if (chunk.some((item) => props.pinned!(item))) for (const near of [index - 1, index, index + 1]) pinned.add(near)
    })
    return pinned
  })
  const samples = new Map<number, { height: number; count: number }>()
  const estimate = (count: number) => {
    let height = 0, items = 0
    for (const sample of samples.values()) { height += sample.height; items += sample.count }
    return Math.round(count * (items > 0 ? height / items : ESTIMATED_ITEM_HEIGHT_PX))
  }

  return (
    <Index each={chunks()}>
      {(chunk, chunkIndex) => {
        const [near, setNear] = createSignal(false)
        const [focused, setFocused] = createSignal(false)
        const heightKey = () => `${props.cacheKey}:${props.itemKey(chunk()[0])}:${chunk().length}`
        const mounted = createMemo(() => !virtualized() || near() || focused() || pinnedChunks().has(chunkIndex))
        let element!: HTMLDivElement

        createEffect(() => {
          if (!viewport || !virtualized()) return
          onCleanup(viewport.observe(element, {
            setNear,
            isMounted: mounted,
            measured: (height) => {
              rememberHeight(heightKey(), height)
              samples.set(chunkIndex, { height, count: chunk().length })
            },
          }))
        })
        onCleanup(() => samples.delete(chunkIndex))

        return (
          <div
            ref={element}
            class={props.class ? `virtual-chunk ${props.class}` : "virtual-chunk"}
            data-virtual-chunk={mounted() ? undefined : "placeholder"}
            style={mounted() ? undefined : { height: `${measuredHeights.get(heightKey()) ?? estimate(chunk().length)}px` }}
            onFocusIn={() => setFocused(true)}
            onFocusOut={(event) => {
              if (!element.contains(event.relatedTarget as Node | null)) setFocused(false)
            }}
          >
            <Show when={mounted()}>
              <Show when={props.keyed} fallback={<Index each={chunk()}>{(item) => props.children(item)}</Index>}>
                <For each={chunk()}>{(item) => props.children(() => item)}</For>
              </Show>
            </Show>
          </div>
        )
      }}
    </Index>
  )
}
