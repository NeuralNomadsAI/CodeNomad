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
 * Toast 歷史記錄項目
 * Toast history record item
 */
export interface IToastHistoryItem {
  /** 唯一識別碼 / Unique identifier */
  id: string;
  /** 通知標題（可選）/ Notification title (optional) */
  title?: string;
  /** 通知訊息 / Notification message */
  message: string;
  /** 變體類型 / Variant type */
  variant: ToastVariant;
  /** 創建時間戳 / Creation timestamp */
  createdAt: number;
  /** 是否已讀（點擊過）/ Read state (clicked) */
  read: boolean;
  /** 操作連結（可選）/ Action link (optional) */
  action?: {
    label: string;
    href: string;
  };
}

/**
 * Toast 歷史篩選條件
 * Toast history filter options
 */
export interface IToastHistoryFilter {
  /** 按變體類型篩選 / Filter by variant type */
  variant?: ToastVariant;
  /** 最大返回數量 / Maximum number of results */
  limit?: number;
  /** 只返回未讀 / Only return unread */
  unreadOnly?: boolean;
}

/** 歷史記錄變化回調函式 / History change callback type */
type ToastHistoryCallback = (items: IToastHistoryItem[]) => void;

// ==================== Toast History Store ====================

/** 最大歷史記錄數量 / Maximum history records */
const MAX_HISTORY_ITEMS = 100;

/** 歷史記錄（模組級別私有狀態）/ History records (module-level private state) */
let _historyItems: IToastHistoryItem[] = [];

/** 訂閱者列表 / Subscribers list */
const _subscribers = new Set<ToastHistoryCallback>();

/** 未讀數量響應式信號 / Reactive signal for unread count */
const [_unreadCount, _setUnreadCount] = createSignal(0);

/**
 * 獲取未讀數量的響應式信號
 * Get reactive signal for unread count
 *
 * 用於組件中直接訪問，以確保響應性
 * Used in components for direct access to ensure reactivity
 *
 * @returns 未讀數量信號 / Unread count signal
 */
export function getUnreadToastCountSignal() {
  return _unreadCount;
}

/**
 * 更新未讀計數信號
 * Update unread count signal
 */
function _updateUnreadCount(): void {
  _setUnreadCount(_historyItems.filter((item) => !item.read).length);
}

/**
 * 通知所有訂閱者
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
 * 生成唯一 ID
 * Generate unique ID
 */
function _generateId(): string {
  return `toast_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 修剪歷史記錄至最大數量
 * Trim history to max items
 *
 * 注意：陣列是 newest-first 排列（unshift），所以 slice(0, N) 保留最新的 N 筆
 * Note: Array is newest-first (unshift), so slice(0, N) keeps newest N items
 */
function _trimHistory(): void {
  if (_historyItems.length > MAX_HISTORY_ITEMS) {
    // 保留最新的記錄（取前 MAX_HISTORY_ITEMS 筆，即最新的）
    _historyItems = _historyItems.slice(0, MAX_HISTORY_ITEMS);
  }
}

// ==================== Toast History API ====================

/**
 * 添加 Toast 到歷史記錄
 * Add toast to history
 *
 * @param item - 歷史記錄項目（不含 id, createdAt, read）/ History item (without id, createdAt, read)
 * @returns 生成的通知 ID / Generated notification ID
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

  // 添加到開頭（最新在前）
  _historyItems.unshift(historyItem);

  // 修剪至最大數量
  _trimHistory();

  // 更新未讀計數
  _updateUnreadCount();

  // 通知訂閱者
  _notifySubscribers();

  return historyItem.id;
}

/**
 * 清除所有歷史記錄
 * Clear all history
 */
export function clearToastHistory(): void {
  _historyItems = [];
  _updateUnreadCount();
  _notifySubscribers();
}

/**
 * 標記為已讀
 * Mark as read
 *
 * @param id - 記錄 ID / Record ID
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
 * 標記所有為已讀
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
 * 刪除單項記錄
 * Delete single record
 *
 * @param id - 記錄 ID / Record ID
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
 * 獲取歷史記錄
 * Get history records
 *
 * @param filter - 篩選條件（可選）/ Filter condition (optional)
 * @returns 歷史記錄陣列 / History records array
 */
export function getToastHistory(filter?: IToastHistoryFilter): IToastHistoryItem[] {
  let items = [..._historyItems];

  // 按 variant 篩選
  if (filter?.variant) {
    items = items.filter((item) => item.variant === filter.variant);
  }

  // 只返回未讀
  if (filter?.unreadOnly) {
    items = items.filter((item) => !item.read);
  }

  // 限制數量
  if (filter?.limit && filter.limit > 0) {
    items = items.slice(0, filter.limit);
  }

  return items;
}

/**
 * 獲取未讀數量
 * Get unread count
 *
 * @returns 未讀通知數量 / Unread notification count
 */
export function getUnreadToastCount(): number {
  return _historyItems.filter((item) => !item.read).length;
}

/**
 * 訂閱歷史記錄變化
 * Subscribe to history changes
 *
 * @param callback - 回調函式 / Callback function
 * @returns 取消訂閱函式 / Unsubscribe function
 */
export function subscribeToastHistory(callback: ToastHistoryCallback): () => void {
  _subscribers.add(callback);

  // 立即觸發一次，回調當前狀態
  callback([..._historyItems]);

  // 返回取消訂閱函式
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
 * 顯示 Toast 通知
 * Show toast notification
 *
 * 同時會將通知添加到歷史記錄中
 * Also adds the notification to history
 *
 * @param payload - Toast 負載 / Toast payload
 * @returns Toast 控制句柄 / Toast handle
 */
export function showToastNotification(payload: ToastPayload): ToastHandle {
  const accent = variantAccent[payload.variant]
  const duration = payload.duration ?? 10000

  // 添加到歷史記錄（不阻塞 UI）
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
 * 獲取 Variant 顯示名稱
 * Get variant display name
 *
 * @param variant - 變體類型 / Variant type
 * @returns 顯示名稱 / Display name
 */
export function getToastVariantLabel(variant: ToastVariant): string {
  const labels: Record<ToastVariant, string> = {
    info: "Info",
    success: "Success",
    warning: "Warning",
    error: "Error",
  };
  return labels[variant];
}

/**
 * 獲取 Variant 的 CSS 類名
 * Get variant CSS class names
 *
 * @param variant - 變體類型 / Variant type
 * @param type - 獲取的類型 / Type of class to get
 * @returns CSS 類名 / CSS class name
 */
export function getToastVariantClasses(
  variant: ToastVariant,
  type: "badge" | "container" | "headline" | "body"
): string {
  return variantAccent[variant][type];
}
