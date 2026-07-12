import { awaitRestoreStep, getAbortReason } from "./app-session-restore-timeout"

export async function completeAbortableRestoreCreation<T>(
  creation: Promise<T>,
  options: {
    signal?: AbortSignal
    commit: (value: T) => void
    discard: (value: T) => Promise<void>
  },
): Promise<T> {
  const value = await creation
  if (options.signal?.aborted) {
    await options.discard(value)
    throw getAbortReason(options.signal)
  }
  options.commit(value)
  return value
}

export async function completeAbortableRestoreHydration<T>(
  value: T,
  options: {
    signal: AbortSignal
    hydrate: (value: T) => Promise<void>
    commit: (value: T) => void
    discard?: (value: T) => Promise<void>
    retainOnAbort?: (reason: Error) => boolean
  },
): Promise<T> {
  try {
    if (options.signal.aborted) throw getAbortReason(options.signal)
    await awaitRestoreStep(options.hydrate(value), options.signal)
    if (options.signal.aborted) throw getAbortReason(options.signal)
    options.commit(value)
    return value
  } catch (error) {
    if (options.signal.aborted) {
      const reason = getAbortReason(options.signal)
      if (!options.retainOnAbort?.(reason)) await options.discard?.(value)
    }
    throw error
  }
}
