import toast from "solid-toast"

export type ToastVariant = "info" | "success" | "warning" | "error"

export type ToastHandle = {
  id: string
  dismiss: () => void
}

type ToastPosition = "top-left" | "top-right" | "top-center" | "bottom-left" | "bottom-right" | "bottom-center"

export type ToastPayload = {
  title?: string
  message: string
  variant: ToastVariant
  duration?: number
  position?: ToastPosition
  action?: {
    label: string
    href: string
  }
}

// Duration defaults by variant (in ms)
const variantDuration: Record<ToastVariant, number> = {
  info: 4000,
  success: 3000,
  warning: 5000,
  error: 8000,
}

const variantAccent: Record<
  ToastVariant,
  {
    badge: string
    container: string
    headline: string
    body: string
  }
> = {
  info: {
    badge: "bg-sky-500/40",
    container: "bg-slate-900/95 border-slate-700 text-slate-100",
    headline: "text-slate-50",
    body: "text-slate-200/80",
  },
  success: {
    badge: "bg-emerald-500/40",
    container: "bg-emerald-950/90 border-emerald-800 text-emerald-50",
    headline: "text-emerald-50",
    body: "text-emerald-100/80",
  },
  warning: {
    badge: "bg-amber-500/40",
    container: "bg-amber-950/90 border-amber-800 text-amber-50",
    headline: "text-amber-50",
    body: "text-amber-100/80",
  },
  error: {
    badge: "bg-rose-500/40",
    container: "bg-rose-950/90 border-rose-800 text-rose-50",
    headline: "text-rose-50",
    body: "text-rose-100/80",
  },
}

export function showToastNotification(payload: ToastPayload): ToastHandle {
  const accent = variantAccent[payload.variant]
  const duration = payload.duration ?? variantDuration[payload.variant]

  let toastId: string

  const dismiss = () => toast.dismiss(toastId)

  toastId = toast.custom(
    () => (
      <div
        class={`pointer-events-auto w-[260px] max-w-[280px] rounded-md border px-3 py-2 shadow-lg cursor-pointer transition-opacity hover:opacity-90 ${accent.container}`}
        style={{ "margin-right": "40px" }}
        onClick={dismiss}
        title="Click to dismiss"
      >
        <div class="flex items-start gap-2">
          <span class={`mt-0.5 inline-block h-2 w-2 rounded-full flex-shrink-0 ${accent.badge}`} />
          <div class="flex-1 text-xs leading-snug min-w-0">
            {payload.title && <p class={`font-semibold truncate ${accent.headline}`}>{payload.title}</p>}
            <p class={`${accent.body} ${payload.title ? "mt-0.5" : ""}`}>{payload.message}</p>
            {payload.action && (
              <a
                class="mt-2 inline-flex items-center text-xs font-semibold uppercase tracking-wide text-sky-300 hover:text-sky-200"
                href={payload.action.href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
              >
                {payload.action.label}
              </a>
            )}
          </div>
        </div>
      </div>
    ),
    {
      duration,
      position: payload.position ?? "top-right",
      ariaProps: {
        role: "status",
        "aria-live": "polite",
      },
    },
  )

  return {
    id: toastId,
    dismiss,
  }
}
