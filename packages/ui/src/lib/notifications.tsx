import toast from "solid-toast"
import { createSignal } from "solid-js"
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

// ==================== Toast History Types ====================

/**
 * Toast history record item
 */
export interface IToastHistoryItem {
  /** Unique identifier */
  id: string;
  /** Notification title (optional) */
  title?: string;
  /** Notification message */
  message: string;
  /** Variant type */
  variant: ToastVariant;
  /** Creation timestamp */
  createdAt: number;
  /** Read state (clicked) */
  read: boolean;
  /** Action link (optional) */
  action?: {
    label: string;
    href: string;
  };
}

/**
 * Toast history filter options
 */
export interface IToastHistoryFilter {
  /** Filter by variant type */
  variant?: ToastVariant;
  /** Maximum number of results */
  limit?: number;
  /** Only return unread */
  unreadOnly?: boolean;
}

/** History change callback type */
type ToastHistoryCallback = (items: IToastHistoryItem[]) => void;

// ==================== Toast History Store ====================

/** Maximum history records */
const MAX_HISTORY_ITEMS = 50;

/** History records (module-level private state) */
let _historyItems: IToastHistoryItem[] = [];

/** Subscribers list */
const _subscribers = new Set<ToastHistoryCallback>();

/** Reactive signal for unread count */
const [_unreadCount, _setUnreadCount] = createSignal(0);

/**
 * Get reactive signal for unread count
 *
 * Used in components for direct access to ensure reactivity
 *
 * @returns Unread count signal
 */
export function getUnreadToastCountSignal() {
  return _unreadCount;
}

/**
 * Update unread count signal
 */
function _updateUnreadCount(): void {
  _setUnreadCount(_historyItems.filter((item) => !item.read).length);
}

/**
 * Notify all subscribers
 */
function _notifySubscribers(): void {
  const items = [..._historyItems];
  _subscribers.forEach((callback) => {
    try {
      callback(items);
    } catch (error) {
      console.error("[notifications] subscriber error:", error);
    }
  });
}

/**
 * Generate unique ID
 */
function _generateId(): string {
  return `toast_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Trim history to max items
 *
 * Note: Array is newest-first (unshift), so slice(0, N) keeps newest N items
 */
function _trimHistory(): void {
  if (_historyItems.length > MAX_HISTORY_ITEMS) {
    // Keep only the newest entries
    _historyItems = _historyItems.slice(0, MAX_HISTORY_ITEMS);
  }
}

// ==================== Toast History API ====================

/**
 * Add toast to history
 *
 * @param item - History item (without id, createdAt, read)
 * @returns Generated notification ID
 */
export function addToToastHistory(
  item: Omit<IToastHistoryItem, "id" | "createdAt" | "read">
): string {
  const historyItem: IToastHistoryItem = {
    ...item,
    id: _generateId(),
    createdAt: Date.now(),
    read: false,
  };

  // Prepend to beginning (newest first)
  _historyItems.unshift(historyItem);

  // Trim to max items
  _trimHistory();

  // Update unread count
  _updateUnreadCount();

  // Notify subscribers
  _notifySubscribers();

  return historyItem.id;
}

/**
 * Clear all history
 */
export function clearToastHistory(): void {
  _historyItems = [];
  _updateUnreadCount();
  _notifySubscribers();
}

/**
 * Mark as read
 *
 * @param id - Record ID
 */
export function markToastHistoryAsRead(id: string): void {
  const item = _historyItems.find((i) => i.id === id);
  if (item && !item.read) {
    item.read = true;
    _updateUnreadCount();
    _notifySubscribers();
  }
}

/**
 * Mark all as read
 */
export function markAllToastHistoryAsRead(): void {
  let changed = false;
  _historyItems.forEach((item) => {
    if (!item.read) {
      item.read = true;
      changed = true;
    }
  });
  if (changed) {
    _updateUnreadCount();
    _notifySubscribers();
  }
}

/**
 * Delete single record
 *
 * @param id - Record ID
 */
export function deleteToastHistoryItem(id: string): void {
  const index = _historyItems.findIndex((i) => i.id === id);
  if (index !== -1) {
    _historyItems.splice(index, 1);
    _updateUnreadCount();
    _notifySubscribers();
  }
}

/**
 * Get history records
 * Get history records
 *
 * @param filter - Filter condition (optional)
 * @returns History records array
 */
export function getToastHistory(filter?: IToastHistoryFilter): IToastHistoryItem[] {
  let items = [..._historyItems];

  // Filter by variant
  if (filter?.variant) {
    items = items.filter((item) => item.variant === filter.variant);
  }

  // Filter: unread only
  if (filter?.unreadOnly) {
    items = items.filter((item) => !item.read);
  }

  // Limit count
  if (filter?.limit && filter.limit > 0) {
    items = items.slice(0, filter.limit);
  }

  return items;
}

/**
 * Get unread count
 *
 * @returns Unread notification count
 */
export function getUnreadToastCount(): number {
  return _historyItems.filter((item) => !item.read).length;
}

/**
 * Subscribe to history changes
 *
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function subscribeToastHistory(callback: ToastHistoryCallback): () => void {
  _subscribers.add(callback);

  // Immediately invoke with current state
  callback([..._historyItems]);

  // Return unsubscribe function
  return () => {
    _subscribers.delete(callback);
  };
}

// ==================== External URL Handler ====================

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

// ==================== Variant Accent Styles ====================

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

// ==================== Toast Notification ====================

/**
 * Show toast notification
 *
 * Also adds the notification to history
 *
 * @param payload - Toast payload
 * @returns Toast handle
 */
export function showToastNotification(payload: ToastPayload): ToastHandle {
  const accent = variantAccent[payload.variant]
  const duration = payload.duration ?? 10000

  // Add to history (non-blocking)
  addToToastHistory({
    title: payload.title,
    message: payload.message,
    variant: payload.variant,
    action: payload.action,
  })

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
          <div class="min-w-0 flex-1 text-sm leading-snug">
            {payload.title && <p class={`break-words ${accent.headline} font-semibold`}>{payload.title}</p>}
            <p class={`${accent.body} ${payload.title ? "mt-1" : ""} whitespace-pre-wrap break-words [overflow-wrap:anywhere]`}>
              {payload.message}
            </p>
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

// ==================== Variant Utilities ====================

/**
 * Get variant display name
 *
 * @param variant - Variant type
 * @returns Display name
 *
 * @note Currently unused, kept for future extension
 */
function getToastVariantLabel(variant: ToastVariant): string {
  const labels: Record<ToastVariant, string> = {
    info: "Info",
    success: "Success",
    warning: "Warning",
    error: "Error",
  };
  return labels[variant];
}

/**
 * Get variant CSS class names
 *
 * @param variant - Variant type
 * @param type - Type of class to get
 * @returns CSS class name
 *
 * @note Currently unused, kept for future extension
 */
function getToastVariantClasses(
  variant: ToastVariant,
  type: "badge" | "container" | "headline" | "body"
): string {
  return variantAccent[variant][type];
}
