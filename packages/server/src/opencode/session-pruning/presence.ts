import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export const PRESENCE_INTERVAL_MS = 2_000
export const PRESENCE_EXPIRY_MS = 15_000

export async function hasPresence(directory: string, now = Date.now()): Promise<boolean> {
  const names = await readdir(directory).catch(() => [])
  const active = await Promise.all(names.filter(name => /^[\da-f-]+\.lease$/.test(name)).map(async name => {
    const entry = await stat(path.join(directory, name)).catch(() => undefined)
    return Boolean(entry?.isFile() && now - entry.mtimeMs < PRESENCE_EXPIRY_MS)
  }))
  return active.some(Boolean)
}

// Serial reconciliation prevents overlapping setup/dispose and resurrection on unload.
export async function followPresence(
  directory: string,
  register: () => Promise<() => void | Promise<void>>,
  onError: (error: unknown) => void = console.error,
) {
  let dispose: (() => void | Promise<void>) | undefined
  let stopped = false
  let pending: Promise<void> | undefined
  const reconcile = () => {
    if (pending) return pending
    pending = (async () => {
      const active = !stopped && await hasPresence(directory)
      if (active && !dispose && !stopped) dispose = await register()
      if ((!active || stopped) && dispose) {
        await dispose()
        dispose = undefined
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  await reconcile()
  const timer = setInterval(() => void reconcile().catch(onError), PRESENCE_INTERVAL_MS)
  timer.unref?.()
  return async () => {
    stopped = true
    clearInterval(timer)
    await pending?.catch(onError)
    await reconcile()
  }
}
