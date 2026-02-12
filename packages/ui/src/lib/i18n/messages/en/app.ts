export const appMessages = {
  "app.launchError.title": "Unable to launch OpenCode",
  "app.launchError.description": "We couldn't start the selected OpenCode binary. Review the error output below or choose a different binary from Advanced Settings.",
  "app.launchError.binaryPathLabel": "Binary path",
  "app.launchError.errorOutputLabel": "Error output",
  "app.launchError.openAdvancedSettings": "Open Advanced Settings",
  "app.launchError.close": "Close",
  "app.launchError.closeTitle": "Close (Esc)",
  "app.launchError.fallbackMessage": "Failed to launch workspace",

  "app.stopInstance.confirmMessage": "Stop OpenCode instance? This will stop the server.",
  "app.stopInstance.title": "Stop instance",
  "app.stopInstance.confirmLabel": "Stop",
  "app.stopInstance.cancelLabel": "Keep running",

  "emptyState.logoAlt": "CodeNomad logo",
  "emptyState.brandTitle": "CodeNomad",
  "emptyState.tagline": "Select a folder to start coding with AI",
  "emptyState.actions.selectFolder": "Select Folder",
  "emptyState.actions.selecting": "Selecting...",
  "emptyState.keyboardShortcut": "Keyboard shortcut: {shortcut}",
  "emptyState.examples": "Examples: {example}",
  "emptyState.multipleInstances": "You can have multiple instances of the same folder",

  "releases.upgradeRequired.title": "Upgrade required",
  "releases.upgradeRequired.message.withVersion": "Update to CodeNomad {version} to use the latest UI.",
  "releases.upgradeRequired.message.noVersion": "Update CodeNomad to use the latest UI.",
  "releases.upgradeRequired.action.getUpdate": "Get update",

  "releases.uiUpdated.title": "UI updated",
  "releases.uiUpdated.message": "UI is now updated to {version}.",

  "releases.devUpdateAvailable.title": "Dev build available",
  "releases.devUpdateAvailable.message": "A new dev build is available: {version}.",
  "releases.devUpdateAvailable.action": "View release",

  "theme.mode.system": "System",
  "theme.mode.light": "Light",
  "theme.mode.dark": "Dark",
  "theme.toggle.title": "Theme: {mode}",
  "theme.toggle.ariaLabel": "Theme: {mode}",
} as const
