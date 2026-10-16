import { createComponent, mergeProps } from "solid-js"
// Aliased by message-scroll.test.ts to Virtua's own Solid build, so importing
// it here never loops back onto the `virtua/solid` alias of this module.
import { Virtualizer as NativeVirtualizer, type VirtualizerHandle, type VirtualizerProps } from "virtua-solid-native"

export * from "virtua-solid-native"

const COUNTED = ["scrollTo", "scrollBy", "scrollToIndex"] as const

/** Virtua's Virtualizer, recording the scroll operations callers issue through
 * its handle in `window.virtuaHandleCalls`. Virtua's own edge compensation
 * writes the DOM directly and is not recorded. Otherwise transparent. */
export function Virtualizer<T>(props: VirtualizerProps<T>) {
  return createComponent(NativeVirtualizer, mergeProps(props, {
    ref: (handle?: VirtualizerHandle) => {
      const w = window as any
      if (handle) {
        w.virtuaHandles = (w.virtuaHandles ?? 0) + 1
        for (const method of COUNTED) {
          const native = handle[method] as (...args: unknown[]) => void
          ;(handle as any)[method] = (...args: unknown[]) => {
            ;(w.virtuaHandleCalls ??= []).push({ method, args })
            return native(...args)
          }
        }
      }
      props.ref?.(handle as VirtualizerHandle)
    },
  }))
}
