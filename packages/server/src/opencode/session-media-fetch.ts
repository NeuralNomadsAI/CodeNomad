import { MESSAGE_LIMIT } from "./session-media-contract"
import { boundedResponseFetch } from "./bounded-response-fetch"

/** Media-only seam around an already captured transport. Fetch supplies decoded bytes. */
export function boundedMediaFetch(fetch: typeof globalThis.fetch, signal: AbortSignal, current: () => void): typeof globalThis.fetch {
  return boundedResponseFetch(fetch, signal, current, MESSAGE_LIMIT)
}
