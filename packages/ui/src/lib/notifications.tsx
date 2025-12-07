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
  const duration = payload.duration ?? 10000

  const id = toast.custom(
    () => (
      <div class={`pointer-events-auto w-[320px] max-w-[360px] rounded-lg border px-4 py-3 shadow-xl ${accent.container}`}>
        <div class="flex items-start gap-3">
          <span class={`mt-1 inline-block h-2.5 w-2.5 rounded-full ${accent.badge}`} />
          <div class="flex-1 text-sm leading-snug">
            {payload.title && <p class={`font-semibold ${accent.headline}`}>{payload.title}</p>}
            <p class={`${accent.body} ${payload.title ? "mt-1" : ""}`}>{payload.message}</p>
            {payload.action && (
              <a
                class="mt-3 inline-flex items-center text-xs font-semibold uppercase tracking-wide text-sky-300 hover:text-sky-200"
                href={payload.action.href}
                target="_blank"
                rel="noreferrer noopener"
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
    id,
    dismiss: () => toast.dismiss(id),
  }
}
