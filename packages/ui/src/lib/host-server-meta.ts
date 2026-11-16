import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"

// Shared with low-level credential admission without importing the HTTP client.
export const [hostServerMeta, setHostServerMeta] = createSignal<ServerMeta | null>(null)
export const secretEntryAllowed = () => (hostServerMeta()?.secretEntryAllowed ?? hostServerMeta()?.localRequest) === true
