import { advancedSettingsMessages } from "./advancedSettings"
import { appMessages } from "./app"
import { commandMessages } from "./commands"
import { dialogMessages } from "./dialogs"
import { filesystemMessages } from "./filesystem"
import { folderSelectionMessages } from "./folderSelection"
import { instanceMessages } from "./instance"
import { loadingScreenMessages } from "./loadingScreen"
import { logMessages } from "./logs"
import { markdownMessages } from "./markdown"
import { messagingMessages } from "./messaging"
import { missionMessages } from "./missions"
import { missionRecoveryMessages } from "./mission-recovery"
import { missionConversationMessages } from "./mission-conversations"
import { sessionMissionMessages } from "./sessions-missions"
import { permissionReceiptMessages } from "./permission-receipts"
import { remoteAccessMessages } from "./remoteAccess"
import { remoteControlMessages } from "./remoteControl"
import { sessionMessages } from "./session"
import { settingsMessages } from "./settings"
import { timeMessages } from "./time"
import { toolCallMessages } from "./toolCall"
import { mergeMessageParts } from "../merge"

export const deMessages = mergeMessageParts(
  folderSelectionMessages,
  advancedSettingsMessages,
  loadingScreenMessages,
  timeMessages,
  appMessages,
  dialogMessages,
  filesystemMessages,
  instanceMessages,
  logMessages,
  sessionMessages,
  messagingMessages,
  missionMessages,
  missionRecoveryMessages,
  missionConversationMessages,
  sessionMissionMessages,
  permissionReceiptMessages,
  toolCallMessages,
  markdownMessages,
  settingsMessages,
  remoteAccessMessages,
  remoteControlMessages,
  commandMessages,
)
