import { createSignal } from "solid-js"

/** Selection identity shared by view stores and the session action layer. */
export const [activeSessionId, setActiveSessionId] = createSignal<Map<string, string>>(new Map())
