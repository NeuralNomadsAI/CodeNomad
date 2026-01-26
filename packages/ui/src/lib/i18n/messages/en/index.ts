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
import { remoteAccessMessages } from "./remoteAccess"
import { sessionMessages } from "./session"
import { settingsMessages } from "./settings"
import { timeMessages } from "./time"
import { toolCallMessages } from "./toolCall"
import { mergeMessageParts } from "../merge"

export const enMessages = mergeMessageParts(
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
  toolCallMessages,
  markdownMessages,
  settingsMessages,
  remoteAccessMessages,
  commandMessages,
)
