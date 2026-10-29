# Descargar CodeNomad

Aplicación de escritorio gratuita y de código abierto (MIT) para Windows, macOS y Linux. Se conecta a tu servicio OpenCode; comprueba primero los [requisitos](install.md#requirements).

## Aplicaciones de escritorio {#desktop}

{{release}}

{{download-button}}

| Plataforma | Tauri (recomendada) | Electron |
| --- | --- | --- |
| Windows 10 o posterior | [Instalador, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 o posterior | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (probado en Ubuntu 24.04) | [AppImage, x64](release:tauri-linux-x64) | [Paquete Debian, x64](release:electron-linux-x64) |

Ambas compilaciones ofrecen el mismo espacio de trabajo. Tauri puede instalar actualizaciones desde la propia aplicación; Electron se actualiza descargando una nueva versión y admite la automatización nativa del navegador en todas las plataformas (Tauri solo en Windows). [Compara las compilaciones](install.md#desktop-downloads).

## Gestores de paquetes {#package-managers}

En Windows, winget instala la compilación Tauri:

```sh
winget install NeuralNomadsAI.CodeNomad
```

Para ejecutar CodeNomad como servidor independiente y usarlo en un navegador, inícialo con npm en un equipo anfitrión con Node.js 24:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

La página del [servidor independiente](server.md#run) cubre el primer inicio de sesión, la instalación global, las direcciones y la autenticación; los [requisitos](install.md#requirements) enumeran Node.js, Git y OpenCode.

## Instalación y primer inicio {#verify-and-install}

Descarga solo desde esta página o desde las [versiones oficiales](https://github.com/NeuralNomadsAI/CodeNomad/releases), y nunca ejecutes un archivo de origen no fiable solo para eludir una advertencia.

- **Linux**: haz ejecutable la AppImage o instala el paquete Debian; consulta [Instalar en Linux](install.md#linux-install).
- **macOS**: si macOS bloquea el primer inicio, consulta [Cuarentena de macOS](troubleshooting.md#macos-quarantine).
- **Todas las plataformas**: instala Git y una CLI de OpenCode compatible según se indica en los [requisitos](install.md#requirements) y, después, [selecciona OpenCode en el primer inicio](install.md#first-launch). Otros problemas de inicio se tratan en la [solución de problemas](troubleshooting.md#desktop-launch).
