/**
 * Toast History Panel
 *
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
  runToastAction,
  subscribeToastHistory,
} from "../lib/notifications"

// ==================== Types ====================

interface ToastHistoryPanelProps {
  /** Close callback */
  onClose: () => void;
  /** Open settings callback (optional) */
  onOpenSettings?: () => void;
}

// ==================== Constants ====================

/** Filter options */
const FILTER_OPTIONS: { value: ToastVariant | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "toastHistory.filter.all" },
  { value: "info", labelKey: "toastHistory.filter.info" },
  { value: "success", labelKey: "toastHistory.filter.success" },
  { value: "warning", labelKey: "toastHistory.filter.warning" },
  { value: "error", labelKey: "toastHistory.filter.error" },
]

/** Variant indicator CSS class mapping */
const VARIANT_INDICATOR_CLASS: Record<ToastVariant, string> = {
  info: "toast-history-indicator-info",
  success: "toast-history-indicator-success",
  warning: "toast-history-indicator-warning",
  error: "toast-history-indicator-error",
}

// ==================== Utilities ====================

/**
 * Format time display
 *
 * @param timestamp - Timestamp
 * @returns Formatted time string
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Get date group key
 *
 * @param timestamp - Timestamp
 * @returns Group key
 */
function getDateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Compare dates ignoring time
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
 * Check if item starts a new day group
 *
 * @param current - Current item
 * @param previous - Previous item
 * @returns Whether it is a new day
 */
function isNewDayGroup(current: IToastHistoryItem, previous: IToastHistoryItem | undefined): boolean {
  if (!previous) return true;
  return getDateGroup(current.createdAt) !== getDateGroup(previous.createdAt);
}

// ==================== Component ====================

const ToastHistoryPanel: Component<ToastHistoryPanelProps> = (props) => {
  const { t } = useI18n();

  // State
  const [historyItems, setHistoryItems] = createSignal<IToastHistoryItem[]>([]);
  const [activeFilter, setActiveFilter] = createSignal<ToastVariant | "all">("all");

  // Filtered history
  const filteredItems = createMemo(() => {
    const filter = activeFilter();
    if (filter === "all") {
      return historyItems();
    }
    return historyItems().filter((item) => item.variant === filter);
  });

  // Grouped history
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

  // Whether there are no history items at all
  const isEmpty = createMemo(() => historyItems().length === 0);

  // Whether filtered results are empty (has history but no matches)
  const isFilterEmpty = createMemo(() => !isEmpty() && filteredItems().length === 0);

  // Has unread
  const hasUnread = createMemo(() => historyItems().some((item) => !item.read));

  // Subscribe to history changes
  createEffect(() => {
    const unsubscribe = subscribeToastHistory((items) => {
      setHistoryItems(items);
    });

    onCleanup(() => {
      unsubscribe();
    });
  });

  // Close on ESC
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

  // Handle item click
  const handleItemClick = (item: IToastHistoryItem) => {
    if (!item.read) {
      markToastHistoryAsRead(item.id);
    }
  };

  // Handle delete
  const handleDelete = (event: MouseEvent, itemId: string) => {
    event.stopPropagation();
    deleteToastHistoryItem(itemId);
  };

  // Handle clear all
  const handleClearAll = () => {
    clearToastHistory();
  };

  // Handle mark all as read
  const handleMarkAllAsRead = () => {
    markAllToastHistoryAsRead();
  };

  const unreadCount = createMemo(() => historyItems().filter((i) => !i.read).length);

  return (
    <div
      class="toast-history-panel window-shell flex flex-col overflow-hidden border border-base bg-surface-base"
      role="dialog"
      aria-label={t("toastHistory.title")}
    >
        {/* Header */}
        <header class="window-header">
          <div class="flex items-center gap-[var(--space-sm)] min-w-0">
            <Bell class="window-leading-icon" aria-hidden="true" />
            <h2 class="window-title truncate">{t("toastHistory.title")}</h2>
            <Show when={hasUnread()}>
              <span
                class="inline-flex items-center justify-center min-w-4 h-4 px-1 bg-[var(--accent-primary)] text-[var(--text-on-accent)] text-[10px] font-medium flex-shrink-0"
                aria-label={t("toastHistory.unread", { count: unreadCount() })}
              >
                {unreadCount()}
              </span>
            </Show>
          </div>
          <button
            type="button"
            class="toast-history-close-btn window-icon-button cursor-pointer"
            onClick={props.onClose}
            aria-label={t("toastHistory.close")}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <Show when={!isEmpty() || props.onOpenSettings}>
          <div class="window-toolbar justify-end overflow-x-auto">
            <Show when={!isEmpty()}>
              <button
                type="button"
                class="toast-history-action-btn window-action cursor-pointer"
                onClick={handleMarkAllAsRead}
                title={t("toastHistory.markAllRead")}
              >
                {t("toastHistory.markAllRead")}
              </button>
              <button
                type="button"
                class="toast-history-action-btn toast-history-action-btn-danger window-action cursor-pointer"
                onClick={handleClearAll}
                title={t("toastHistory.clearAll")}
              >
                <Trash2 class="w-3 h-3" aria-hidden="true" />
                {t("toastHistory.clearAll")}
              </button>
            </Show>
            <Show when={props.onOpenSettings}>
              <button
                type="button"
                class="toast-history-action-btn window-action cursor-pointer"
                onClick={props.onOpenSettings}
                title={t("toastHistory.viewSettings")}
              >
                {t("toastHistory.viewSettings")}
              </button>
            </Show>
          </div>
        </Show>

        {/* Filter */}
        <Show when={!isEmpty()}>
          <div class="window-toolbar toast-history-filter-toolbar overflow-x-auto" aria-label={t("toastHistory.filter.label")}>
            <For each={FILTER_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class="toast-history-filter-btn window-action cursor-pointer"
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
        <div class="window-body toast-history-body overflow-x-hidden">
          <Show
            when={!isEmpty()}
            fallback={
              <div class="flex flex-col items-center justify-center p-[var(--space-lg)] text-secondary text-center">
                <Bell class="w-6 h-6 opacity-40 mb-[var(--space-sm)]" aria-hidden="true" />
                <p class="m-0 text-[var(--font-size-xs)]">{t("toastHistory.empty")}</p>
              </div>
            }
          >
            <Show
              when={!isFilterEmpty()}
              fallback={
                <div class="flex flex-col items-center justify-center p-[var(--space-lg)] text-secondary text-center">
                  <Bell class="w-6 h-6 opacity-40 mb-[var(--space-sm)]" aria-hidden="true" />
                  <p class="m-0 text-[var(--font-size-xs)]">{t("toastHistory.empty.filter")}</p>
                </div>
              }
            >
            <For each={groupedItems()}>
              {(group) => (
                <div class="px-[var(--space-sm)] py-[var(--space-xs)]">
                  <div class="px-[var(--space-xs)] py-[var(--space-xs)] text-[10px] font-medium text-muted uppercase tracking-wide">{t(group.labelKey)}</div>
                  <ul role="list" class="flex flex-col list-none p-0 m-0">
                     <For each={group.items}>
                       {(item, index) => (
                          <>
                            {/* Toast history item - Semantic list item with proper ARIA semantics */}
                           <li
                             tabIndex={0}
                              class="toast-history-item flex items-start gap-[var(--space-sm)] px-[var(--space-xs)] py-[var(--space-sm)] border-0 border-b border-base bg-transparent relative w-full text-start font-inherit text-inherit cursor-pointer"
                             classList={{
                               "toast-history-item-unread": !item.read,
                             }}
                             onClick={() => handleItemClick(item)}
                             onKeyDown={(e) => {
                               if (e.key === "Enter" || e.key === " ") {
                                 e.preventDefault();
                                 handleItemClick(item);
                               }
                             }}
                           >
                            <span
                               class={`w-1.5 h-1.5 flex-shrink-0 mt-[0.3rem] toast-history-indicator ${VARIANT_INDICATOR_CLASS[item.variant]}`}
                              aria-hidden="true"
                            />
                            <div class="flex-1 min-w-0">
                               <div class="flex items-center gap-[var(--space-sm)]">
                                 <Show when={item.title}>
                                   <span class="text-[var(--font-size-xs)] font-medium text-primary">{item.title}</span>
                                 </Show>
                                 <span class="text-[10px] text-muted flex-shrink-0">{formatTime(item.createdAt)}</span>
                               </div>
                               <p class="text-[11px] text-secondary m-0 line-clamp-2">{item.message}</p>
                              <Show when={item.action}>
                                <button
                                  type="button"
                                   class="toast-history-item-action inline-flex items-center gap-1 text-[10px] mt-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (item.action) {
                                      void runToastAction(item.action);
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
                               class="toast-history-item-delete inline-flex items-center justify-center w-5 h-5 border-none bg-transparent text-muted cursor-pointer flex-shrink-0"
                              onClick={(e) => handleDelete(e, item.id)}
                              aria-label={t("toastHistory.deleteItem")}
                              title={t("toastHistory.deleteItem")}
                            >
                               <X class="w-3 h-3" aria-hidden="true" />
                            </button>
                            <Show when={!item.read}>
                               <span class="toast-history-item-unread-dot absolute top-[var(--space-sm)] right-[var(--space-sm)] w-1.5 h-1.5" aria-hidden="true" />
                            </Show>
                           </li>
                         </>
                       )}
                     </For>
                   </ul>
                 </div>
              )}
             </For>
            </Show>
          </Show>
        </div>
    </div>
  );
};

export default ToastHistoryPanel;
