import toast from "solid-toast"
import { isTauriHost } from "./runtime-env"

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

async function openExternalUrl(url: string): Promise<void> {
  if (typeof window === "undefined") {
    return
  }

  try {
    if (isTauriHost()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
      return
    }
  } catch (error) {
    // Fall through to browser handling.
    // Note: on Linux, system opener failures can throw here.
    console.warn("[notifications] unable to open via system opener", error)
  }

  try {
    window.open(url, "_blank", "noopener,noreferrer")
  } catch (error) {
    console.warn("[notifications] unable to open external url", error)
    toast.error("Unable to open link")
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
      <div
        class={`pointer-events-auto relative w-[320px] max-w-[360px] rounded-lg border px-4 py-3 shadow-xl ${accent.container}`}
      >
        <button
          type="button"
          class="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-200/80 hover:text-slate-50 hover:bg-white/10"
          aria-label="Close notification"
          title="Close"
          onClick={() => toast.dismiss(id)}
        >
          x
        </button>
        <div class="flex items-start gap-3 pr-6">
          <span class={`mt-1 inline-block h-2.5 w-2.5 rounded-full ${accent.badge}`} />
          <div class="flex-1 text-sm leading-snug">
            {payload.title && <p class={`font-semibold ${accent.headline}`}>{payload.title}</p>}
            <p class={`${accent.body} ${payload.title ? "mt-1" : ""}`}>{payload.message}</p>
            {payload.action && (
              <button
                type="button"
                class="mt-3 inline-flex items-center text-xs font-semibold uppercase tracking-wide text-sky-300 hover:text-sky-200"
                onClick={() => void openExternalUrl(payload.action!.href)}
              >
                {payload.action.label}
              </button>
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
