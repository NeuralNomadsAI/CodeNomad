import { describeKeyTarget } from "./virtual-follow-behavior"

export type UserMessageJumpDirection = "previous" | "next"

/** Asks the shown conversation to jump; the palette commands dispatch it. */
export const JUMP_USER_MESSAGE_EVENT = "codenomad:jump-user-message"

export interface JumpUserMessageDetail {
  instanceId: string
  sessionId: string
  direction: UserMessageJumpDirection
}

export function requestUserMessageJump(detail: JumpUserMessageDetail) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<JumpUserMessageDetail>(JUMP_USER_MESSAGE_EVENT, { detail }))
}

/**
 * The user message nearest to `current` in `direction`, strictly before or
 * after it. `markers` lists the session in order, possibly several per message
 * (the timeline's segments, which include indexed history beyond the resident
 * window). `resident` is the list's order: it places a current message without
 * a marker between its neighbours. Without a known position, Previous starts
 * from the end and Next finds nothing.
 */
export function findUserMessageJumpTarget(input: {
  markers: readonly { messageId: string; type: string }[]
  resident: readonly string[]
  current: string | null
  direction: UserMessageJumpDirection
}): string | null {
  const order: string[] = []
  const users = new Set<string>()
  for (const marker of input.markers) {
    if (order[order.length - 1] !== marker.messageId) order.push(marker.messageId)
    if (marker.type === "user") users.add(marker.messageId)
  }
  const positions = new Map(order.map((messageId, position) => [messageId, position]))
  // `before` is the last marked message preceding the current one; `after` the first following it.
  let before: number | undefined
  let after: number | undefined
  const exact = input.current === null ? undefined : positions.get(input.current)
  if (exact !== undefined) {
    before = exact - 1
    after = exact + 1
  } else {
    const residentAt = input.current === null ? -1 : input.resident.indexOf(input.current)
    for (let index = residentAt - 1; residentAt >= 0 && index >= 0 && before === undefined; index--) {
      before = positions.get(input.resident[index])
    }
    for (let index = residentAt + 1; residentAt >= 0 && index < input.resident.length && after === undefined; index++) {
      after = positions.get(input.resident[index])
    }
    if (before !== undefined) after = before + 1
    else if (after !== undefined) before = after - 1
  }
  if (input.direction === "previous") {
    for (let index = before ?? order.length - 1; index >= 0; index--) if (users.has(order[index])) return order[index]
    return null
  }
  if (after === undefined) return null
  for (let index = after; index < order.length; index++) if (users.has(order[index])) return order[index]
  return null
}

// Modified arrows move lines in the code editor, reach the terminal's program and
// open selects and popup buttons (Alt+Down).
const MODIFIED_ARROW_TARGETS = ".monaco-editor, .xterm, select, [aria-haspopup]:not([aria-haspopup='false'])"
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"])

/**
 * Text fields, the composer included, allow the jump. Code editors, terminals,
 * arrow-key widgets, popup triggers, other inputs and IME composition keep it.
 */
export function keyAllowsUserMessageJump(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  const target = event.target as HTMLInputElement | null
  if (typeof target?.closest !== "function") return true
  if (target.closest(MODIFIED_ARROW_TARGETS) || describeKeyTarget(target).arrowWidget) return false
  return target.tagName !== "INPUT" || TEXT_INPUT_TYPES.has(target.type)
}
