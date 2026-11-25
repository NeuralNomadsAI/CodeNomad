import { createEffect, createMemo, onCleanup, untrack } from "solid-js"

export const MISSION_HELD_REREAD_MS = 5_000

/** Rereads a held, unconfirmed request until it settles: nobody has to ask for it. */
export function rereadMissionHoldWhileActive(held: () => unknown, active: () => boolean, reread: () => Promise<void>) {
  const watching = createMemo(() => Boolean(held()) && active())
  createEffect(() => {
    if (!watching()) return
    untrack(() => { void reread() })
    const timer = setInterval(() => void reread(), MISSION_HELD_REREAD_MS)
    onCleanup(() => clearInterval(timer))
  })
}
