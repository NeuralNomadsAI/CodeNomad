# CodeNomad herunterladen

Kostenlose Open-Source-Desktop-App (MIT) für Windows, macOS und Linux. Sie verbindet sich mit Ihrem OpenCode-Dienst; prüfen Sie zuerst die [Anforderungen](install.md#requirements).

## Desktop-Apps {#desktop}

{{release}}

{{download-button}}

| Plattform | Tauri (empfohlen) | Electron |
| --- | --- | --- |
| Windows 10 oder neuer | [Installationsprogramm, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 oder neuer | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (unter Ubuntu 24.04 getestet) | [AppImage, x64](release:tauri-linux-x64) | [Debian-Paket, x64](release:electron-linux-x64) |

Beide Builds bieten denselben Arbeitsbereich. Tauri kann Updates direkt in der App installieren; Electron wird durch Herunterladen eines neuen Releases aktualisiert und unterstützt native Browser-Automatisierung auf allen Plattformen (Tauri nur unter Windows). [Builds vergleichen](install.md#desktop-downloads).

## Paketmanager {#package-managers}

Unter Windows installiert winget den Tauri-Build:

```sh
winget install NeuralNomadsAI.CodeNomad
```

Um CodeNomad als eigenständigen Server zu betreiben und im Browser zu verwenden, starten Sie ihn mit npm auf einem Host mit Node.js 24:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

Die Seite [Eigenständiger Server](server.md#run) behandelt die erste Anmeldung, die globale Installation, Adressen und Authentifizierung; die [Anforderungen](install.md#requirements) nennen Node.js, Git und OpenCode.

## Installation und erster Start {#verify-and-install}

Laden Sie nur von dieser Seite oder den [offiziellen Releases](https://github.com/NeuralNomadsAI/CodeNomad/releases) herunter, und führen Sie niemals ein nicht vertrauenswürdiges Archiv aus, nur um eine Warnung zu umgehen.

- **Linux**: Machen Sie das AppImage ausführbar oder installieren Sie das Debian-Paket; siehe [Unter Linux installieren](install.md#linux-install).
- **macOS**: Blockiert macOS den ersten Start, siehe [macOS-Quarantäne](troubleshooting.md#macos-quarantine).
- **Alle Plattformen**: Installieren Sie Git und eine kompatible OpenCode-CLI wie in den [Anforderungen](install.md#requirements) aufgeführt und [wählen Sie dann OpenCode beim ersten Start](install.md#first-launch). Andere Startprobleme behandelt die [Fehlerbehebung](troubleshooting.md#desktop-launch).

## Entwicklung unterstützen {#support-development}

CodeNomad ist kostenlos und wird von Freiwilligen in ihrer Freizeit gepflegt. Wenn es Ihnen oder Ihrem Team nützt, hilft Sponsoring, es zu pflegen und mit neuen OpenCode-Releases kompatibel zu halten. Die Seite [CodeNomad unterstützen](sponsor.md) erklärt, was Sponsoring finanziert.

{{funding}}
