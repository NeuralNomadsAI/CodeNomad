# Télécharger CodeNomad

Application de bureau libre et open source (MIT) pour Windows, macOS et Linux. Elle se connecte à votre service OpenCode ; vérifiez d’abord les [prérequis](install.md#requirements).

## Applications de bureau {#desktop}

{{release}}

{{download-button}}

| Plateforme | Tauri (recommandée) | Electron |
| --- | --- | --- |
| Windows 10 ou ultérieur | [Installateur, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 ou ultérieur | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (testé sur Ubuntu 24.04) | [AppImage, x64](release:tauri-linux-x64) | [Paquet Debian, x64](release:electron-linux-x64) |

Les deux distributions offrent le même espace de travail. Tauri peut installer les mises à jour depuis l’application ; Electron se met à jour en téléchargeant une nouvelle version et prend en charge l’automatisation native du navigateur sur toutes les plateformes (Tauri uniquement sous Windows). [Comparer les distributions](install.md#desktop-downloads).

## Gestionnaires de paquets {#package-managers}

Sous Windows, winget installe la distribution Tauri :

```sh
winget install NeuralNomadsAI.CodeNomad
```

Pour exécuter CodeNomad comme serveur autonome et l’utiliser dans un navigateur, lancez-le avec npm sur un hôte disposant de Node.js 24 :

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

La page du [serveur autonome](server.md#run) couvre la première connexion, l’installation globale, les adresses et l’authentification ; les [prérequis](install.md#requirements) indiquent Node.js, Git et OpenCode.

## Installation et premier lancement {#verify-and-install}

Téléchargez uniquement depuis cette page ou les [versions officielles](https://github.com/NeuralNomadsAI/CodeNomad/releases), et n’exécutez jamais une archive non fiable simplement pour contourner un avertissement.

- **Linux** : rendez l’AppImage exécutable ou installez le paquet Debian ; voir [Installer sous Linux](install.md#linux-install).
- **macOS** : si macOS bloque le premier lancement, voir [Quarantaine macOS](troubleshooting.md#macos-quarantine).
- **Toutes les plateformes** : installez Git et une CLI OpenCode compatible comme indiqué dans les [prérequis](install.md#requirements), puis [sélectionnez OpenCode au premier lancement](install.md#first-launch). Les autres problèmes de lancement sont traités dans le [dépannage](troubleshooting.md#desktop-launch).

## Soutenir le développement {#support-development}

CodeNomad est gratuit et maintenu par des bénévoles sur leur temps libre. S’il vous est utile, à vous ou à votre équipe, le parrainage aide à le maintenir et à le garder compatible avec les nouvelles versions d’OpenCode. La page [Soutenir CodeNomad](sponsor.md) explique ce que finance le parrainage.

{{funding}}
