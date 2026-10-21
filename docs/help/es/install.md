# Instalar CodeNomad

Elige un equipo de escritorio local o ejecuta el [servidor independiente](server.md). En ambos casos, OpenCode es propietario del servicio nativo compartido y del historial.

## Descargas de escritorio {#desktop-downloads}

1. Abre [la última versión](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest).
2. Elige la compilación que corresponda a tu sistema operativo y procesador.
3. Extrae el ZIP o instala/ejecuta el paquete de la plataforma y, después, inicia CodeNomad.

| Plataforma | Versión Electron | Versión Tauri | Notas de la plataforma |
| --- | --- | --- | --- |
| macOS | ZIP, Intel o Apple Silicon | ZIP, Intel o Apple Silicon | El entorno de ejecución incluido requiere macOS 13.5 o posterior. |
| Windows | ZIP, x64 | Instalador, x64 | Windows 10 o posterior; Tauri usa WebView2. |
| Linux | Paquete Debian, x64 | AppImage, x64 | Compilado y probado en Ubuntu 24.04; no se garantiza la compatibilidad con distribuciones anteriores. |

Las versiones de escritorio incluyen los recursos de ejecución necesarios para el backend y el instalador de OpenCode, por lo que no necesitas instalar Node.js/npm por separado para usarlas. Git no está incluido. La automatización nativa del navegador es compatible con Electron y Tauri para Windows; las demás plataformas Tauri usan vistas previas iframe.

Si una descarga verificada se bloquea al iniciarse, consulta la [solución de problemas de la plataforma](troubleshooting.md#desktop-launch). Nunca ejecutes un archivo de origen no fiable solo para eludir una advertencia.

## Instalar en Linux {#linux-install}

Desde la carpeta que contiene la versión descargada, sustituye la versión y el nombre de archivo por los reales:

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

Para la AppImage de Tauri:

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Si FUSE no está disponible, usa el modo de extracción y ejecución de la AppImage:

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

La instalación Debian de Electron configura el aislamiento de Chromium. No desactives ese aislamiento para solucionar un problema de instalación. Los problemas gráficos de Tauri en Linux tienen una [solución específica de WebKit](troubleshooting.md#desktop-launch).

## Requisitos {#requirements}

| Requisito | Dónde debe estar disponible | Requisito actual |
| --- | --- | --- |
| CLI de OpenCode | Equipo de ejecución seleccionado, incluida la distribución WSL seleccionada cuando corresponda | Mínimo **2.1.2**; **2.1.2** es la versión recomendada/verificada. Las versiones más nuevas o personalizadas pasan una validación de contratos en lugar de prohibirse por no haberse probado. |
| Git | `PATH` de la cuenta del backend de CodeNomad | Necesario para la identidad del repositorio, las operaciones Git y los worktrees. |
| Node.js/npm | Equipo del servidor independiente y de compilación desde el código fuente | Node.js 24 LTS; las compilaciones reproducibles desde el código fuente usan `.node-version` (**24.20.0**). Incluido con los recursos de ejecución/instalación de escritorio. |
| Carpeta del espacio de trabajo | Disco accesible para el backend | Una carpeta física abierta explícitamente, no una carpeta local del dispositivo deducida por un navegador remoto. |

En Windows, instala [Git for Windows](https://gitforwindows.org/) con el acceso desde la línea de comandos/aplicaciones de terceros activado. Basta con una instalación por usuario en la que este pueda escribir. En macOS/Linux, sigue las [instrucciones de Git para tu plataforma](https://git-scm.com/downloads).

Después de cambiar `PATH`, sal completamente de la aplicación de escritorio y vuelve a iniciarla, o reinicia el backend independiente con la cuenta prevista. Recargar un navegador no actualiza el entorno del backend. Que Git esté disponible solo dentro de WSL no satisface el requisito de Git de un backend de Windows.

Sin Git, aún puedes abrir una carpeta física y usar conversaciones limitadas al directorio, incluso pedir ayuda de instalación al agente. Las operaciones de repositorio/worktree siguen sin estar disponibles; el acceso a las sesiones permanece limitado a esa carpeta exacta. CodeNomad informa al agente sobre la disponibilidad de Git en el backend antes de los mensajes/comandos personalizados y retira ese aviso tras la recuperación. El equipo de ejecución del agente puede ser distinto del equipo del backend, así que instala Git para el backend, no solo para el shell del agente.

## Seleccionar OpenCode en el primer inicio {#first-launch}

1. Durante la configuración inicial, elige un ejecutable compatible existente o usa la acción de instalación de OpenCode ofrecida.
2. Verifica el estado del entorno de ejecución antes de abrir un proyecto.
3. Vuelve a **Preferencias → OpenCode** para gestionar por separado el ejecutable, la instalación y el servicio compartido.

CodeNomad prefiere ejecutables compatibles presentes en `PATH` y admite seleccionar explícitamente un ejecutable. Instalar/actualizar una CLI no reinicia silenciosamente un servicio compartido que ya esté en ejecución. Consulta la [configuración de OpenCode](opencode.md) para conocer las consecuencias de reiniciar/recargar, WSL y el entorno de las sesiones.

## Usar un navegador en su lugar {#browser-install}

Instala Node.js/npm, Git y OpenCode en el equipo servidor y sigue los [procedimientos de inicio del servidor](server.md). Conéctate con la dirección indicada, la autenticación configurada y un certificado de confianza. Un navegador/PWA necesita un backend activo; no es una copia sin conexión de tus proyectos.

Para puertos, direcciones de escucha y TLS, consulta [acceso directo](remote-access.md). Para emparejar un dispositivo sin abrir puertos entrantes, usa [Control remoto](remote-control.md). Para los comandos de desarrollo y empaquetado, consulta [compilaciones desde el código fuente](support.md#build-from-source).
