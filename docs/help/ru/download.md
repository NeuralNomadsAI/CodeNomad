# Скачать CodeNomad

Бесплатное настольное приложение с открытым исходным кодом (MIT) для Windows, macOS и Linux. Оно подключается к вашей службе OpenCode; сначала проверьте [требования](install.md#requirements).

## Настольные приложения {#desktop}

{{release}}

{{download-button}}

| Платформа | Tauri (рекомендуется) | Electron |
| --- | --- | --- |
| Windows 10 или новее | [Установщик, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 или новее | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (проверено на Ubuntu 24.04) | [AppImage, x64](release:tauri-linux-x64) | [Пакет Debian, x64](release:electron-linux-x64) |

Обе сборки предоставляют одинаковое рабочее пространство. Tauri может устанавливать обновления внутри приложения; Electron обновляется загрузкой нового релиза и поддерживает нативную автоматизацию браузера на всех платформах (Tauri — только в Windows). [Сравните сборки](install.md#desktop-downloads).

## Менеджеры пакетов {#package-managers}

В Windows winget устанавливает сборку Tauri:

```sh
winget install NeuralNomadsAI.CodeNomad
```

Чтобы запустить CodeNomad как отдельный сервер и использовать его в браузере, запустите его через npm на хосте с Node.js 24:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

Страница [отдельного сервера](server.md#run) описывает первый вход, глобальную установку, адреса и аутентификацию; в [требованиях](install.md#requirements) перечислены Node.js, Git и OpenCode.

## Установка и первый запуск {#verify-and-install}

Скачивайте только с этой страницы или из [официальных релизов](https://github.com/NeuralNomadsAI/CodeNomad/releases) и никогда не запускайте недоверенный архив только ради обхода предупреждения.

- **Linux**: сделайте AppImage исполняемым или установите пакет Debian; см. [Установка в Linux](install.md#linux-install).
- **macOS**: если macOS блокирует первый запуск, см. [Карантин macOS](troubleshooting.md#macos-quarantine).
- **Все платформы**: установите Git и совместимый OpenCode CLI, как указано в [требованиях](install.md#requirements), затем [выберите OpenCode при первом запуске](install.md#first-launch). Другие проблемы запуска описаны в разделе [устранения неполадок](troubleshooting.md#desktop-launch).
