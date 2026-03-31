/** @jsxImportSource solid-js */
import { type ParentComponent, JSX } from "solid-js"
import { I18nProvider } from "./i18n"
import { ConfigContext, type ConfigContextValue } from "../stores/preferences"

const mockConfigValue: ConfigContextValue = {
  preferences: () => ({} as any),
  serverSettings: () => ({} as any),
  isLoaded: () => true,
  updatePreferences: () => { },
  setThemePreference: () => { },
  setListeningMode: async () => { },
  updateEnvironmentVariables: () => { },
  addEnvironmentVariable: () => { },
  removeEnvironmentVariable: () => { },
  updateLastUsedBinary: () => { },
  recentFolders: () => [],
  opencodeBinaries: () => [],
  uiState: () => ({} as any),
  addRecentFolder: () => { },
  removeRecentFolder: () => { },
  addOpenCodeBinary: () => { },
  removeOpenCodeBinary: () => { },
  recordWorkspaceLaunch: () => { },
  addRecentModelPreference: () => { },
  isFavoriteModelPreference: () => false,
  toggleFavoriteModelPreference: () => { },
  getModelThinkingSelection: () => undefined,
  setModelThinkingSelection: () => { },
  toggleShowThinkingBlocks: () => { },
  toggleKeyboardShortcutHints: () => { },
  toggleShowTimelineTools: () => { },
  toggleUsageMetrics: () => { },
  toggleAutoCleanupBlankSessions: () => { },
  togglePromptSubmitOnEnter: () => { },
  setDiffViewMode: () => { },
  setToolOutputExpansion: () => { },
  setDiagnosticsExpansion: () => { },
  setThinkingBlocksExpansion: () => { },
  setToolInputsVisibility: () => { },
  setAgentModelPreference: async () => { },
  getAgentModelPreference: async () => undefined,
  themePreference: () => "system",
}

export const TestProvider: ParentComponent = (props): JSX.Element => {
  return (
    <ConfigContext.Provider value={mockConfigValue}>
      <I18nProvider>
        {props.children}
      </I18nProvider>
    </ConfigContext.Provider>
  )
}
