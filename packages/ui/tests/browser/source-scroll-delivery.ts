import type { Page } from "playwright"

/** Retain real listbox scroll listeners, without changing their callback bodies. */
export async function installSourceScrollDelivery(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { __name: Object })
    const prototype = EventTarget.prototype, add = prototype.addEventListener, remove = prototype.removeEventListener
    const registrations = new WeakMap<EventTarget, Map<EventListenerOrEventListenerObject, Map<boolean, EventListener>>>()
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
      let listeners = registrations.get(this)
      if (!listeners) registrations.set(this, listeners = new Map())
      let captures = listeners.get(listener)
      if (!captures) listeners.set(listener, captures = new Map())
      let wrapper = captures.get(capture)
      if (!wrapper) {
        let active = true
        const target = this
        wrapper = function(event) {
          const deliver = () => {
            if (active && !(typeof options === "object" && options.signal?.aborted)) {
              if (typeof listener === "function") listener.call(this, event)
              else listener.handleEvent.call(listener, event)
            }
          }
          if (armed && target instanceof Element && target.matches('.mission-source-popover [role="listbox"]')) {
            retained++; pending.push(deliver)
          } else deliver()
        }
        // Native removal still owns listener lifetime, including queued deliveries.
        Object.assign(wrapper, { revoke: () => { active = false } })
        captures.set(capture, wrapper)
        const registered = wrapper
        cleanup.add(() => { active = false; remove.call(target, type, registered, capture) })
      }
      return add.call(this, type, wrapper, options)
    }
    prototype.removeEventListener = function(type, listener, options) {
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture)
      const captures = listener && registrations.get(this)?.get(listener)
      const wrapper = type === "scroll" && captures?.get(capture)
      if (wrapper) {
        (wrapper as EventListener & { revoke(): void }).revoke()
        captures!.delete(capture)
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
