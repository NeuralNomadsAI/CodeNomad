import { mergeMessageParts } from "../merge"
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
import { remoteControlMessages } from "./remoteControl"
import { sessionMessages } from "./session"
import { settingsMessages } from "./settings"
import { timeMessages } from "./time"
import { toolCallMessages } from "./toolCall"

export const trMessages = mergeMessageParts(
  advancedSettingsMessages,
  appMessages,
  commandMessages,
  dialogMessages,
  filesystemMessages,
  folderSelectionMessages,
  instanceMessages,
  loadingScreenMessages,
  logMessages,
  markdownMessages,
  messagingMessages,
  remoteControlMessages,
  sessionMessages,
  settingsMessages,
  timeMessages,
  toolCallMessages,
)
