import type { Component } from "solid-js"
import { AlertTriangle } from "lucide-solid"

interface LoadErrorStateProps {
  title: string
  error: string
  retryLabel: string
  onRetry: () => void
  variant?: "compact" | "panel"
}

const LoadErrorState: Component<LoadErrorStateProps> = (props) => {
  const content = (
    <div class={props.variant === "compact" ? "flex items-start gap-2" : "flex flex-col items-center text-center"}>
      <AlertTriangle
        class={props.variant === "compact" ? "mt-0.5 h-4 w-4 flex-shrink-0 text-danger" : "mb-3 h-6 w-6 text-danger"}
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-medium text-danger">{props.title}</h3>
        <p class="mt-2 break-words text-xs leading-5 text-muted">{props.error}</p>
        <button type="button" class="button-tertiary mt-3" onClick={props.onRetry}>
          {props.retryLabel}
        </button>
      </div>
    </div>
  )

  if (props.variant === "compact") {
    return <div class="m-3 border border-danger bg-danger/10 p-3" role="alert">{content}</div>
  }

  return (
    <div class="flex flex-1 items-center justify-center p-12" role="alert">
      <div class="w-full max-w-md border border-danger bg-danger/10 p-6">{content}</div>
    </div>
  )
}

export default LoadErrorState
