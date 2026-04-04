/**
 * Toast 歷史記錄面板
 * Toast History Panel
 *
 * 顯示所有 Toast 通知的歷史記錄
 * Displays history of all toast notifications
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js"
import { X, Bell, Trash2, ExternalLink } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import {
  type IToastHistoryItem,
  type ToastVariant,
  clearToastHistory,
  deleteToastHistoryItem,
  markAllToastHistoryAsRead,
  markToastHistoryAsRead,
  subscribeToastHistory,
} from "../lib/notifications"
import { isTauriHost } from "../lib/runtime-env"

// ==================== Types ====================

interface ToastHistoryPanelProps {
  /** 關閉回調 / Close callback */
  onClose: () => void;
  /** 開啟設定回調（可選）/ Open settings callback (optional) */
  onOpenSettings?: () => void;
}

// ==================== Constants ====================

/** 篩選器選項 / Filter options */
const FILTER_OPTIONS: { value: ToastVariant | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "toastHistory.filter.all" },
  { value: "info", labelKey: "toastHistory.filter.info" },
  { value: "success", labelKey: "toastHistory.filter.success" },
  { value: "warning", labelKey: "toastHistory.filter.warning" },
  { value: "error", labelKey: "toastHistory.filter.error" },
]

/** Variant 指示點 CSS 類名映射 / Variant indicator CSS class mapping */
const VARIANT_INDICATOR_CLASS: Record<ToastVariant, string> = {
  info: "toast-history-indicator-info",
  success: "toast-history-indicator-success",
  warning: "toast-history-indicator-warning",
  error: "toast-history-indicator-error",
}

// ==================== Utilities ====================

/**
 * 格式化時間顯示
 * Format time display
 *
 * @param timestamp - 時間戳 / Timestamp
 * @returns 格式化後的字串 / Formatted string
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 獲取日期分組鍵
 * Get date group key
 *
 * @param timestamp - 時間戳 / Timestamp
 * @returns 分組鍵 / Group key
 */
function getDateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // 比較日期（忽略時間）
  const isSameDay = (d1: Date, d2: Date) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();

  if (isSameDay(date, today)) {
    return "today";
  } else if (isSameDay(date, yesterday)) {
    return "yesterday";
  } else {
    return "earlier";
  }
}

/**
 * 計算是否為新的一天開始
 * Check if it's start of a new day group
 *
 * @param current - 當前項目 / Current item
 * @param previous - 上一個項目 / Previous item
 * @returns 是否是新的一天 / Whether it's a new day
 */
function isNewDayGroup(current: IToastHistoryItem, previous: IToastHistoryItem | undefined): boolean {
  if (!previous) return true;
  return getDateGroup(current.createdAt) !== getDateGroup(previous.createdAt);
}

// ==================== Component ====================

const ToastHistoryPanel: Component<ToastHistoryPanelProps> = (props) => {
  const { t } = useI18n();

  // 狀態 / State
  const [historyItems, setHistoryItems] = createSignal<IToastHistoryItem[]>([]);
  const [activeFilter, setActiveFilter] = createSignal<ToastVariant | "all">("all");

  // 過濾後的歷史記錄 / Filtered history
  const filteredItems = createMemo(() => {
    const filter = activeFilter();
    if (filter === "all") {
      return historyItems();
    }
    return historyItems().filter((item) => item.variant === filter);
  });

  // 分組後的歷史記錄 / Grouped history
  const groupedItems = createMemo(() => {
    const groups: { key: string; labelKey: string; items: IToastHistoryItem[] }[] = [];
    let currentGroup: (typeof groups)[0] | null = null;

    for (const item of filteredItems()) {
      const dateGroup = getDateGroup(item.createdAt);

      if (!currentGroup || currentGroup.key !== dateGroup) {
        currentGroup = {
          key: dateGroup,
          labelKey: `toastHistory.${dateGroup}`,
          items: [],
        };
        groups.push(currentGroup);
      }

      currentGroup.items.push(item);
    }

    return groups;
  });

  // 是否為空狀態 / Empty state
  const isEmpty = createMemo(() => filteredItems().length === 0);

  // 是否有未讀 / Has unread
  const hasUnread = createMemo(() => historyItems().some((item) => !item.read));

  // 訂閱歷史變化 / Subscribe to history changes
  createEffect(() => {
    const unsubscribe = subscribeToastHistory((items) => {
      setHistoryItems(items);
    });

    onCleanup(() => {
      unsubscribe();
    });
  });

  // ESC 鍵關閉 / Close on ESC
  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  // 處理項目點擊 / Handle item click
  const handleItemClick = (item: IToastHistoryItem) => {
    // 標記為已讀 / Mark as read
    if (!item.read) {
      markToastHistoryAsRead(item.id);
    }

    // 如果有操作連結，打開連結 / Open action link if exists
    if (item.action?.href) {
      void handleOpenAction(item.action.href);
    }
  };

  // 處理刪除 / Handle delete
  const handleDelete = (event: MouseEvent, itemId: string) => {
    event.stopPropagation();
    deleteToastHistoryItem(itemId);
  };

  // 處理清除全部 / Handle clear all
  const handleClearAll = () => {
    clearToastHistory();
  };

  // 處理標記全部已讀 / Handle mark all as read
  const handleMarkAllAsRead = () => {
    markAllToastHistoryAsRead();
  };

  // 打開外部連結 / Open external link
  async function handleOpenAction(href: string): Promise<void> {
    if (isTauriHost()) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
        return;
      } catch (error) {
        console.warn("[toast-history] unable to open via system opener", error);
      }
    }

    window.open(href, "_blank", "noopener,noreferrer");
  }

  // 阻止點擊事件冒泡 / Stop click propagation
  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  };

  const unreadCount = createMemo(() => historyItems().filter((i) => !i.read).length);

  return (
    <div class="toast-history-backdrop" onClick={handleBackdropClick}>
      <div
        class="toast-history-panel flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-base bg-surface-base"
        style={{
          "width": "min(420px, calc(100vw - var(--space-lg) * 2))",
          "max-height": "calc(100vh - var(--space-lg) * 2)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t("toastHistory.title")}
      >
        {/* Header */}
        <header class="flex items-center justify-between gap-[var(--space-md)] p-[var(--space-md)] border-b border-base bg-surface-secondary">
          <div class="flex items-center gap-[var(--space-sm)] min-w-0">
            <Bell class="w-5 h-5 text-primary flex-shrink-0" aria-hidden="true" />
            <h2 class="text-[var(--font-size-base)] font-semibold text-primary m-0 truncate">{t("toastHistory.title")}</h2>
            <Show when={hasUnread()}>
              <span
                class="inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] px-[0.35rem] rounded-full bg-[var(--color-primary)] text-[var(--color-on-primary)] text-[var(--font-size-xs)] font-semibold flex-shrink-0"
                aria-label={t("toastHistory.unread", { count: unreadCount() })}
              >
                {unreadCount()}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-[var(--space-xs)] flex-shrink-0">
            <Show when={!isEmpty()}>
              <button
                type="button"
                class="toast-history-action-btn inline-flex items-center gap-1 px-1 py-0.5 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-[var(--font-size-xs)] font-medium cursor-pointer"
                onClick={handleMarkAllAsRead}
                title={t("toastHistory.markAllRead")}
              >
                {t("toastHistory.markAllRead")}
              </button>
              <button
                type="button"
                class="toast-history-action-btn toast-history-action-btn-danger inline-flex items-center gap-1 px-1 py-0.5 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-[var(--font-size-xs)] font-medium cursor-pointer"
                onClick={handleClearAll}
                title={t("toastHistory.clearAll")}
              >
                <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
                {t("toastHistory.clearAll")}
              </button>
            </Show>
            <Show when={props.onOpenSettings}>
              <button
                type="button"
                class="toast-history-action-btn inline-flex items-center gap-1 px-1 py-0.5 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-[var(--font-size-xs)] font-medium cursor-pointer"
                onClick={props.onOpenSettings}
                title={t("toastHistory.viewSettings")}
              >
                {t("toastHistory.viewSettings")}
              </button>
            </Show>
            <button
              type="button"
              class="toast-history-close-btn inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-primary cursor-pointer"
              onClick={props.onClose}
              aria-label={t("toastHistory.close")}
            >
              <X class="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Filter */}
        <Show when={!isEmpty()}>
          <div class="flex items-center gap-[var(--space-xs)] px-[var(--space-md)] py-[var(--space-sm)] border-b border-base bg-surface-secondary overflow-x-auto" aria-label={t("toastHistory.filter.label")}>
            <For each={FILTER_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class="toast-history-filter-btn px-3 py-1 rounded-full border border-base bg-transparent text-[var(--text-secondary)] text-[var(--font-size-xs)] font-medium cursor-pointer whitespace-nowrap"
                  classList={{
                    "toast-history-filter-btn-active": activeFilter() === option.value,
                    [`toast-history-filter-btn-${option.value}`]: option.value !== "all",
                  }}
                  aria-pressed={activeFilter() === option.value}
                  onClick={() => setActiveFilter(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Content */}
        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <Show
            when={!isEmpty()}
            fallback={
              <div class="flex flex-col items-center justify-center p-[var(--space-xl)] text-secondary text-center">
                <Bell class="w-12 h-12 opacity-50 mb-[var(--space-md)]" aria-hidden="true" />
                <p class="m-0 text-[var(--font-size-sm)]">{t("toastHistory.empty")}</p>
              </div>
            }
          >
            <For each={groupedItems()}>
              {(group) => (
                <div class="p-[var(--space-sm)]">
                  <div class="px-[var(--space-sm)] py-[var(--space-xs)] text-[var(--font-size-xs)] font-semibold text-muted uppercase tracking-wide">{t(group.labelKey)}</div>
                  <div class="flex flex-col gap-[var(--space-xs)]" role="list">
                    <For each={group.items}>
                      {(item, index) => (
                        <>
                          <Show when={index() > 0 && isNewDayGroup(item, group.items[index() - 1])}>
                            {/* 分隔線 / Divider */}
                          </Show>
                          <button
                            type="button"
                            class="toast-history-item flex items-start gap-[var(--space-sm)] px-[var(--space-md)] py-[var(--space-sm)] rounded-[var(--radius-lg)] border-none bg-surface-secondary relative w-full text-start font-inherit text-inherit cursor-pointer"
                            classList={{
                              "toast-history-item-unread": !item.read,
                            }}
                            onClick={() => handleItemClick(item)}
                          >
                            <span
                              class={`w-2 h-2 rounded-full flex-shrink-0 mt-[0.35rem] toast-history-indicator ${VARIANT_INDICATOR_CLASS[item.variant]}`}
                              aria-hidden="true"
                            />
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2">
                                <Show when={item.title}>
                                  <span class="text-sm font-medium text-primary">{item.title}</span>
                                </Show>
                                <span class="text-xs text-muted flex-shrink-0">{formatTime(item.createdAt)}</span>
                              </div>
                              <p class="text-xs text-secondary m-0 line-clamp-2">{item.message}</p>
                              <Show when={item.action}>
                                <button
                                  type="button"
                                  class="toast-history-item-action inline-flex items-center gap-1 text-xs mt-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (item.action?.href) {
                                      void handleOpenAction(item.action.href);
                                    }
                                  }}
                                >
                                  <ExternalLink class="w-3 h-3" aria-hidden="true" />
                                  {item.action!.label}
                                </button>
                              </Show>
                            </div>
                            <button
                              type="button"
                              class="toast-history-item-delete inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] border-none bg-transparent text-muted cursor-pointer flex-shrink-0"
                              onClick={(e) => handleDelete(e, item.id)}
                              aria-label={t("toastHistory.deleteItem")}
                              title={t("toastHistory.deleteItem")}
                            >
                              <X class="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                            <Show when={!item.read}>
                              <span class="toast-history-item-unread-dot absolute top-[var(--space-sm)] right-[var(--space-sm)] w-2 h-2 rounded-full" aria-hidden="true" />
                            </Show>
                          </button>
                        </>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default ToastHistoryPanel;
