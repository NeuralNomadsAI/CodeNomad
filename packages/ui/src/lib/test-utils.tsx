import { type ParentComponent } from "solid-js"
import { I18nProvider, type I18nContextValue } from "@/lib/i18n"
import { ConfigContext, type ConfigContextValue } from "@/stores/preferences"

const mockI18nValue: I18nContextValue = {
  locale: () => "en",
  t: (key: string) => key,
}

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

export const TestProvider: ParentComponent = (props) => {
  return (
    <ConfigContext.Provider value={mockConfigValue}>
      <I18nProvider>
        {props.children}
      </I18nProvider>
    </ConfigContext.Provider>
  )
}
