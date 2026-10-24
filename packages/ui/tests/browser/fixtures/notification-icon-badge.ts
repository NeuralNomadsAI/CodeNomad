import { startNotificationIconBadge } from "../../../src/lib/notification-icon-badge"
import {
  addToToastHistory, clearToastHistory, deleteToastHistoryItem,
  getUnreadToastCount, markAllToastHistoryAsRead, markToastHistoryAsRead,
} from "../../../src/lib/notifications"

const stop = startNotificationIconBadge()
Object.assign(window, { badgeFixture: {
  add: () => addToToastHistory({ message: "Fixture notification", variant: "info" }),
  read: markToastHistoryAsRead, readAll: markAllToastHistoryAsRead,
  remove: deleteToastHistoryItem, clear: clearToastHistory, count: getUnreadToastCount, stop,
} })
