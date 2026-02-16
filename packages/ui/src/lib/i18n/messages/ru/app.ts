export const appMessages = {
  "app.launchError.title": "Не удалось запустить OpenCode",
  "app.launchError.description": "Не удалось запустить выбранный бинарник OpenCode. Просмотрите вывод ошибки ниже или выберите другой бинарник в расширенных настройках.",
  "app.launchError.binaryPathLabel": "Путь к бинарнику",
  "app.launchError.errorOutputLabel": "Вывод ошибки",
  "app.launchError.openAdvancedSettings": "Открыть расширенные настройки",
  "app.launchError.close": "Закрыть",
  "app.launchError.closeTitle": "Закрыть (Esc)",
  "app.launchError.fallbackMessage": "Не удалось запустить рабочее пространство",

  "app.stopInstance.confirmMessage": "Остановить экземпляр OpenCode? Это остановит сервер.",
  "app.stopInstance.title": "Остановить экземпляр",
  "app.stopInstance.confirmLabel": "Остановить",
  "app.stopInstance.cancelLabel": "Оставить запущенным",

  "emptyState.logoAlt": "Логотип CodeNomad",
  "emptyState.brandTitle": "CodeNomad",
  "emptyState.tagline": "Выберите папку, чтобы начать писать код с AI",
  "emptyState.actions.selectFolder": "Выбрать папку",
  "emptyState.actions.selecting": "Выбор…",
  "emptyState.keyboardShortcut": "Горячая клавиша: {shortcut}",
  "emptyState.examples": "Примеры: {example}",
  "emptyState.multipleInstances": "Можно иметь несколько экземпляров одной и той же папки",

  "releases.upgradeRequired.title": "Требуется обновление",
  "releases.upgradeRequired.message.withVersion": "Обновите CodeNomad до версии {version}, чтобы использовать последний UI.",
  "releases.upgradeRequired.message.noVersion": "Обновите CodeNomad, чтобы использовать последний UI.",
  "releases.upgradeRequired.action.getUpdate": "Получить обновление",

  "releases.uiUpdated.title": "UI обновлён",
  "releases.uiUpdated.message": "UI теперь обновлён до {version}.",

  "releases.devUpdateAvailable.title": "Доступна dev-сборка",
  "releases.devUpdateAvailable.message": "Доступна новая dev-сборка: {version}.",
  "releases.devUpdateAvailable.action": "Открыть релиз",
} as const
