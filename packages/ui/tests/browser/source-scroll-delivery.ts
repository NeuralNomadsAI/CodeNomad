import type { Page } from "playwright"

/** Retain real listbox scroll listeners, without changing their callback bodies. */
export async function installSourceScrollDelivery(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { __name: Object })
    const prototype = EventTarget.prototype, add = prototype.addEventListener, remove = prototype.removeEventListener
    type Registration = EventListener & { revoke(): void }
    const registrations = new WeakMap<EventTarget, Map<EventListenerOrEventListenerObject, Map<boolean, Registration>>>()
    const cleanup = new Set<() => void>()
    let armed = false, retained = 0
    const pending: Array<() => void> = []
    const release = () => {
      armed = false
      while (pending.length) pending.shift()!()
      return { retained, pending: pending.length }
    }
    prototype.addEventListener = function(type, listener, options) {
      if (type !== "scroll" || !listener || !(this instanceof Element)
        || !this.matches('.mission-source-popover [role="listbox"]')) return add.call(this, type, listener, options)
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture)
      const signal = typeof options === "object" ? options?.signal : undefined
      if (signal?.aborted) return add.call(this, type, listener, options)
      let listeners = registrations.get(this)
      if (!listeners) registrations.set(this, listeners = new Map())
      let captures = listeners.get(listener)
      if (!captures) listeners.set(listener, captures = new Map())
      let wrapper = captures.get(capture)
      if (!wrapper) {
        let active = true
        const target = this, once = typeof options === "object" && Boolean(options?.once)
        const retire = (revoke: boolean) => {
          if (captures!.get(capture) === registered) captures!.delete(capture)
          if (signal) remove.call(signal, "abort", dispose)
          if (revoke) { active = false; cleanup.delete(dispose) }
        }
        const dispose = () => { retire(true); remove.call(target, type, registered, capture) }
        const registered: Registration = Object.assign(function(this: EventTarget, event: Event) {
          // Native once removal precedes invocation; its consumed delivery still belongs to it.
          if (once) retire(false)
          const deliver = () => {
            if (!active) return
            try {
              if (typeof listener === "function") listener.call(this, event)
              else listener.handleEvent.call(listener, event)
            } finally { if (once) { active = false; cleanup.delete(dispose) } }
          }
          if (armed && target instanceof Element && target.matches('.mission-source-popover [role="listbox"]')) {
            retained++; pending.push(deliver)
          } else deliver()
        }, { revoke: dispose })
        wrapper = registered
        captures.set(capture, registered)
        cleanup.add(dispose)
        try { add.call(target, type, registered, options) } catch (error) { dispose(); throw error }
        if (signal) add.call(signal, "abort", dispose, { once: true })
        return
      }
      return add.call(this, type, wrapper, options)
    }
    prototype.removeEventListener = function(type, listener, options) {
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture)
      const captures = listener && registrations.get(this)?.get(listener)
      const wrapper = type === "scroll" && captures?.get(capture)
      if (wrapper) {
        wrapper.revoke()
      }
      return remove.call(this, type, wrapper || listener, options)
    }
    Object.assign(window, { sourceScrollDelivery: {
      arm: () => { armed = true }, release,
      state: () => ({ armed, retained, pending: pending.length }),
      dispose: () => {
        armed = false
        for (const dispose of cleanup) dispose()
        cleanup.clear(); pending.length = 0
        prototype.addEventListener = add; prototype.removeEventListener = remove
      },
    } })
  })
}

declare global {
  interface Window {
    sourceScrollDelivery: {
      arm(): void
      release(): { retained: number; pending: number }
      state(): { armed: boolean; retained: number; pending: number }
      dispose(): void
    }
  }
}
