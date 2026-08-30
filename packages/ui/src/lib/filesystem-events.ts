import { createSignal } from "solid-js"

const [filesystemInvalidations, setFilesystemInvalidations] = createSignal<Map<string, number>>(new Map())

export function invalidateFilesystemCaches(instanceId: string): void {
  setFilesystemInvalidations((previous) => {
    const next = new Map(previous)
    next.set(instanceId, (next.get(instanceId) ?? 0) + 1)
    return next
  })
}

export function filesystemInvalidationVersion(instanceId: string): number {
  return filesystemInvalidations().get(instanceId) ?? 0
}

export function createDebouncedRefresh(callback: () => void, delay = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    trigger() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        callback()
      }, delay)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
