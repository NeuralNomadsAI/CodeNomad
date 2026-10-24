# Soporte y compilaciones desde el código fuente

Usa el repositorio para informes de errores, versiones actuales y contribuciones. La [guía de solución de problemas](troubleshooting.md) cubre la recuperación segura antes de informar de una incidencia.

## Informar de un error {#report-a-bug}

1. Abre **Configuración → Info → Diagnósticos**.
2. Selecciona **Informar de un error** para abrir el formulario de incidencias de GitHub.
3. Revisa la información de versión/cliente rellenada. Añade una reproducción mínima, el comportamiento esperado y el resultado real y envíalo mediante GitHub.

La acción rellena las versiones de CodeNomad y OpenCode (incluido el servicio OpenCode en ejecución cuando difiere del instalado), tu sistema operativo, el tipo de cliente (con el agente de usuario del navegador en un navegador web) y el sistema operativo del servidor. No rellena direcciones de escucha, rutas de espacios de trabajo, credenciales ni texto de conversaciones. Abrir el formulario no envía una incidencia.

Si necesitas más diagnósticos, **Copiar al portapapeles** o **Descargar .txt** produce un informe separado. Ese informe más completo puede contener rutas locales y direcciones de red: revísalo y oculta datos antes de adjuntarlo. Una captura o fragmento de registro puede contener secretos aunque el informe automático de diagnóstico excluya los secretos de autenticación.

Si el formulario de GitHub tiene campos incompatibles, CodeNomad abre una incidencia sencilla con la misma información del informe. Un fallo temporal al leer el formulario no impide abrirlo. Siempre puedes usar manualmente [la lista de incidencias](https://github.com/NeuralNomadsAI/CodeNomad/issues).

## Comunidad y versiones {#community}

| Recurso | Uso |
| --- | --- |
| [Repositorio de CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) | Código fuente, actividad del proyecto y documentación. |
| [Incidencias](https://github.com/NeuralNomadsAI/CodeNomad/issues) | Busca informes existentes antes de abrir un error reproducible o una petición de función. |
| [Pull requests](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | Revisa cambios propuestos o coordina una contribución. |
| [Última versión](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Artefactos de descarga estables. |
| [Todas las versiones](https://github.com/NeuralNomadsAI/CodeNomad/releases) | Versiones preliminares publicadas y notas de versión. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | Organización del proyecto. |
| [Licencia MIT](../../../LICENSE) | Condiciones de licencia. |

Para problemas de configuración nativa de OpenCode en lugar de controles de CodeNomad, consulta la [documentación de OpenCode](https://opencode.ai/v2/docs/) y las [versiones del proyecto original](https://github.com/anomalyco/opencode/releases).

## Compilar desde el código fuente {#build-from-source}

Usa Node.js **24.20.0**, fijado en `.node-version`, npm, Git y una CLI OpenCode compatible. Ejecuta los comandos desde una copia de desarrollo:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` inicia el anfitrión de desarrollo Electron. Para usar Tauri, instala primero sus [requisitos de compilación de la plataforma](https://v2.tauri.app/start/prerequisites/), incluida la cadena de herramientas Rust, y ejecuta:

```sh
npm run dev:tauri
```

Los cambios de desarrollo afectan al anfitrión de desarrollo, no a la versión instalada de un daemon OpenCode en ejecución independiente. El empaquetado nativo necesita las herramientas adecuadas del destino; prefiere compilar en el sistema operativo de destino.

### Compilar y validar {#build-and-validate}

| Comando, desde la raíz del repositorio | Finalidad |
| --- | --- |
| `npm run build` | Compilar los recursos de la aplicación Electron. |
| `npm run build:tauri` | Compilar la aplicación Tauri con sus requisitos nativos. |
| `npm run build:ui` | Compilar la interfaz de navegador. |
| `npm run build --workspace @neuralnomads/codenomad` | Compilar el servidor independiente y los recursos incluidos. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Empaquetar la versión Debian de Electron. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Empaquetar una AppImage de Tauri para Linux. |
| `npm run typecheck` | Comprobar los espacios de trabajo TypeScript configurados en la raíz. |
| `npm run test:help` | Validar todos los idiomas y enlaces de la ayuda pública. |
| `npm run build:help` | Compilar la ayuda pública independiente en `dist/help`. |

La compilación de ayuda no necesita un servicio CodeNomad u OpenCode en ejecución. Consulta [BUILD.md](../../../BUILD.md) para detalles de empaquetado y [CONTRIBUTING.md](../../../CONTRIBUTING.md) para validación acotada y convenciones de PR; usa los scripts realmente presentes en el paquete de destino.

## Mapa de paquetes y contribución {#contribute}

| Paquete | Responsabilidad |
| --- | --- |
| `packages/server` | Controles de espacio de trabajo/API/Git, conexión OpenCode, autenticación, eventos y voz. |
| `packages/ui` | Espacio de trabajo SolidJS, controles, localización y punto de entrada a la ayuda desde el navegador. |
| `packages/electron-app` | Ventanas Electron, integración nativa y empaquetado. |
| `packages/tauri-app` | Ventanas Tauri, integración de plataforma y empaquetado. |
| `packages/remote-tunnel` | Entorno de transporte OpenTunnel del backend. |

1. Comenta el ámbito en la incidencia correspondiente antes de implementar trabajo que se solape.
2. Crea una rama desde `dev` y mantén el cambio centrado.
3. Ejecuta las comprobaciones del área afectada, actualiza la ayuda de usuario junto con el comportamiento y dirige tu PR a `dev`.

Las fuentes de la ayuda pública están en `docs/help/<locale>/`. Conserva el ID explícito, el nivel y el orden de cada encabezado inglés en todas las traducciones; los encabezados traducidos no deben romper enlaces profundos. El [contrato de mantenimiento de ayuda](../../../dev-docs/USER_HELP.md) describe las comprobaciones estrictas de integridad y el proceso de publicación estática.
