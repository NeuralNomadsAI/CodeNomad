import { backendEvents } from "./backend-events"

/** Capture before enqueue/await. View demand survives; this operation never changes attachment. */
export function captureBackendOperation(instanceId: string, parent?: AbortSignal, owns: () => boolean = () => true) {
  const attachment = backendEvents.signalForInstance(instanceId)
  const signal = parent ? AbortSignal.any([attachment, parent]) : attachment
  return { signal, current: () => !signal.aborted && owns() }
}
