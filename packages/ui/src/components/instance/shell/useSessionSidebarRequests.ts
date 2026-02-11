import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import {
  SESSION_SIDEBAR_EVENT,
  type SessionSidebarRequestAction,
  type SessionSidebarRequestDetail,
} from "../../../lib/session-sidebar-events"

interface PendingSidebarAction {
  action: SessionSidebarRequestAction
  id: number
}

interface UseSessionSidebarRequestsOptions {
  instanceId: Accessor<string>
  sidebarContentEl: Accessor<HTMLElement | null>
  leftPinned: Accessor<boolean>
  leftOpen: Accessor<boolean>
  setLeftOpen: (next: boolean) => void
  measureDrawerHost: () => void
}

export function useSessionSidebarRequests(options: UseSessionSidebarRequestsOptions) {
  let sidebarActionId = 0
  const [pendingSidebarAction, setPendingSidebarAction] = createSignal<PendingSidebarAction | null>(null)

  const triggerKeyboardEvent = (target: HTMLElement, options: { key: string; code: string; keyCode: number }) => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: options.key,
        code: options.code,
        keyCode: options.keyCode,
        which: options.keyCode,
        bubbles: true,
        cancelable: true,
      }),
    )
  }

  const focusAgentSelectorControl = () => {
    const agentTrigger = options.sidebarContentEl()?.querySelector("[data-agent-selector]") as HTMLElement | null
    if (!agentTrigger) return false
    agentTrigger.focus()
    setTimeout(() => triggerKeyboardEvent(agentTrigger, { key: "Enter", code: "Enter", keyCode: 13 }), 10)
    return true
  }

  const focusModelSelectorControl = () => {
    const input = options.sidebarContentEl()?.querySelector<HTMLInputElement>("[data-model-selector]")
    if (!input) return false
    input.focus()
    setTimeout(() => triggerKeyboardEvent(input, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }), 10)
    return true
  }

  const focusVariantSelectorControl = () => {
    const input = options.sidebarContentEl()?.querySelector<HTMLInputElement>("[data-thinking-selector]")
    if (!input) return false
    input.focus()
    setTimeout(() => triggerKeyboardEvent(input, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }), 10)
    return true
  }

  createEffect(() => {
    const pending = pendingSidebarAction()
    if (!pending) return
    const action = pending.action
    const contentReady = Boolean(options.sidebarContentEl())
    if (!contentReady) {
      return
    }
    if (action === "show-session-list") {
      setPendingSidebarAction(null)
      return
    }
    const handled =
      action === "focus-agent-selector"
        ? focusAgentSelectorControl()
        : action === "focus-model-selector"
          ? focusModelSelectorControl()
          : focusVariantSelectorControl()
    if (handled) {
      setPendingSidebarAction(null)
    }
  })

  const handleSidebarRequest = (action: SessionSidebarRequestAction) => {
    setPendingSidebarAction({ action, id: sidebarActionId++ })
    if (!options.leftPinned() && !options.leftOpen()) {
      options.setLeftOpen(true)
      options.measureDrawerHost()
    }
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SessionSidebarRequestDetail>).detail
      if (!detail || detail.instanceId !== options.instanceId()) return
      handleSidebarRequest(detail.action)
    }
    window.addEventListener(SESSION_SIDEBAR_EVENT, handler)
    onCleanup(() => window.removeEventListener(SESSION_SIDEBAR_EVENT, handler))
  })

  return {
    handleSidebarRequest,
    pendingSidebarAction,
  }
}
