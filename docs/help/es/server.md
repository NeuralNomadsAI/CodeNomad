# Servidor independiente

Ejecuta CodeNomad donde estén tus proyectos y herramientas y usa después su interfaz de navegador local o remotamente. El backend proporciona acceso al sistema de archivos, operaciones Git, autenticación y entrega de eventos. El servicio compartido de OpenCode es propietario de las conversaciones y la ejecución; no es un servidor hijo que deba detenerse cuando se desconecta un navegador.

La misma interfaz admite [varias pestañas de proyecto y worktrees](projects.md), [familias de conversaciones y actividad en segundo plano](conversations.md), [carga acotada de historial, búsqueda y navegación por línea de tiempo](history.md), una [paleta de comandos y atajos](shortcuts.md) y [Misiones](missions.md). El acceso desde navegador y tableta no traslada la ejecución fuera del anfitrión.

## Preparar el equipo anfitrión {#prerequisites}

1. Instala Node.js 24 LTS y npm; el entorno de compilación fijado por el repositorio es 24.20.0. Los paquetes de escritorio incluyen Node/npm.
2. Pon Git en el **PATH del proceso del backend**. Git solo dentro de WSL no satisface a un backend Windows.
3. Instala o selecciona OpenCode: el mínimo requerido es **2.1.2**, con **2.1.3** como objetivo recomendado de verificación. Las compilaciones más nuevas o personalizadas pasan comprobaciones de compatibilidad, no una lista de versiones probadas permitidas. Consulta [configuración de OpenCode](opencode.md).
4. Elige la carpeta desde la que iniciar el servidor o pasa `--workspace-root` explícitamente.

Sin Git, las conversaciones siguen disponibles solo en la carpeta física abierta explícitamente; las operaciones Git y worktree fallan. Instala Git y reinicia el backend tras cambiar PATH. Una raíz de espacio de trabajo limita la apertura/exploración, no la ejecución del agente: consulta [Seguridad](security.md).

## Ejecutar o instalar {#run}

Elige un método de instalación. Estos ejemplos de primer inicio usan inicialización local en lugar de poner una contraseña en el historial del shell:

### Ejecutar con npx {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Instalar globalmente {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### Instalar en un proyecto {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad` usa el binario instalado en el proyecto cuando existe. Esto instala el paquete en ese proyecto; **no** hace locales al proyecto la configuración ni el almacenamiento de OpenCode.

1. Abre la **Local Connection URL** indicada en el anfitrión. Completa la [inicialización local](security.md) y guarda una contraseña persistente del servidor. Ese procedimiento incluye una opción de configuración HTTP solo en loopback si aún no has configurado la confianza HTTPS.
2. En inicios posteriores, omite `--generate-token`; como alternativa, proporciona `CODENOMAD_SERVER_PASSWORD` en cada inicio.
3. Usa `codenomad --help` para inspeccionar las opciones de la CLI instalada.

Los comandos se ejecutan en primer plano. Cerrar la terminal o enviar Ctrl+C detiene ese backend y su conexión de Control remoto. `--launch` solo abre un navegador; no convierte el servidor en un daemon. Para disponibilidad desatendida, ejecuta el mismo comando bajo el gestor de procesos/servicios del sistema operativo con configuración, directorio de trabajo, entorno y política de reinicio explícitos. No pongas secretos en registros de servicio ni en un archivo público de unidad.

Cerrar un navegador no detiene un backend independiente que se ejecuta por separado. Cerrar una pestaña de proyecto retira la conexión de CodeNomad de ese proyecto, pero las sesiones siguen en OpenCode; vuelve a abrir el proyecto para encontrarlas. CodeNomad nunca descarga su Location nativa. Cerrar una ventana entera, salir o recargar conserva las conexiones de proyecto para restaurarlas. Apagar el backend también deja el servicio OpenCode en ejecución. Las funciones dependientes del backend no están disponibles hasta que vuelva CodeNomad; consulta [Misiones](missions.md) para la duración separada de la programación nativa.

## Direcciones y puertos {#addresses}

Al iniciar se indica **Local Connection URL**, y **Remote Connection URL** cuando hay una disponible, además de **Other Accessible URLs** cuando corresponde. Usa el esquema y el puerto indicados, no una dirección adivinada. Una URL loopback solo es accesible en ese equipo; una dirección LAN indicada sigue requiriendo enrutamiento y acceso del cortafuegos.

HTTPS prefiere el puerto **9898** y HTTP, **9899**. Sin un valor de puerto explícito, un puerto preferido ocupado se sustituye por uno asignado por el sistema operativo. Un puerto explícito distinto de cero no cambia a otro; `0` solicita un puerto asignado por el sistema operativo. Los puertos aceptan enteros de 0 a 65535.

El backend también puede abrir un listener HTTP autenticado y no anunciado en un puerto aleatorio de `127.0.0.1` para sus propios plugins de OpenCode, como Misiones. No se muestra y no es una dirección de cliente.

Para exposición de listeners, certificados, VPN/SSH y proxies inversos, usa [Acceso remoto directo](remote-access.md). Para acceso sin puerto entrante, usa [Control remoto](remote-control.md).

## Referencia de la CLI pública {#cli-reference}

Las opciones prevalecen sobre sus equivalentes del entorno. Las opciones con valor usan el argumento mostrado; los interruptores no. Los valores HTTPS/HTTP reconocen `1`, `true`, `yes`, `y` y `on` como activados, sin distinguir mayúsculas; usa `true`/`false` explícitos para mayor claridad. La actualización automática de interfaz reconoce `1`, `true` y `yes`.

**Las variables de entorno booleanas estrictas** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` y `CODENOMAD_SKIP_AUTH`) activan sus interruptores con `1`, `true`, `yes` u `on`, sin distinguir mayúsculas y minúsculas e ignorando los espacios alrededor. `0`, `false`, `no`, `off`, los valores vacíos o solo con espacios y las variables sin definir dejan los interruptores desactivados. Cualquier otro valor impide que el servidor arranque, incluso con la opción CLI correspondiente. Una opción CLI activa su interruptor aunque haya un valor válido de desactivación; en caso contrario, se aplican los valores predeterminados `false` de abajo.

| Opción | Entorno | Valor predeterminado y efecto |
| --- | --- | --- |
| `-h, --help` | — | Mostrar la ayuda y salir. |
| `-v, --version` | — | Mostrar la versión instalada del paquete y salir. |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`; `localhost` se normaliza a loopback IPv4. Se rechazan los identificadores de zona IPv6. Consulta la [matriz de escucha](remote-access.md). |
| `--https <enabled>` | `CLI_HTTPS` | `true`; listener HTTPS. |
| `--http <enabled>` | `CLI_HTTP` | `false`; listener HTTP. Debe activarse al menos un listener. |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` preferido; `0` automático. |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` preferido; `0` automático. |
| `--tls-key <path>` | `CLI_TLS_KEY` | Sin definir; clave privada PEM, requiere `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | Sin definir; certificado PEM, requiere `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Sin definir; cadena CA PEM opcional para certificados proporcionados. |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Sin definir; nombres DNS/IP adicionales separados por comas para certificados generados. |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Directorio de trabajo del proceso; raíz para abrir espacios de trabajo. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`; permite explorar todo el sistema de archivos. No es un ajuste de aislamiento del agente. |
| `--config <path>` | `CLI_CONFIG` | Predeterminado activo resuelto: `~/.config/codenomad/config.yaml`. Acepta un directorio o archivo YAML para una ubicación explícita. |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`; niveles documentados: `trace`, `debug`, `info`, `warn`, `error`. |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`; en otro caso escribe en el archivo elegido. |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`; usuario de autenticación de ejecución. Un archivo de autenticación almacenado conserva su usuario guardado si ninguna contraseña de ejecución lo sustituye. |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Sin definir; contraseña solo de ejecución, prevalece sobre el archivo de autenticación gestionado. |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`; los caracteres distintos de letras, dígitos, `_` y `-` se convierten en `_`. |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`; muestra un token de inicialización local de un uso y 60 segundos. |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`; desactiva la autenticación del listener directo. Peligroso: consulta [Seguridad](security.md). Control remoto sigue requiriendo emparejar el dispositivo. |
| `--ui-dir <path>` | `CLI_UI_DIR` | Directorio `public` del paquete; un valor explícito sirve esa interfaz en lugar de resolver la interfaz remota. |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Sin definir; sirve de proxy para la interfaz mediante el listener HTTP. Para desarrollo, usa `--https=false --http=true`; el listener HTTPS no sirve de proxy para la interfaz de desarrollo. |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`; prevalece sobre la actualización automática y usa la interfaz disponible en caché/incluida. |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`; busca una interfaz remota compatible al iniciar. |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`; manifiesto de interfaz remota. |
| `--launch` | `CLI_LAUNCH` | `false`; abre la interfaz local en un navegador tras iniciar. |
| `--upgrade [version]` | — | Sin actualización por defecto. Si se solicita, instala globalmente `@neuralnomads/codenomad@latest` o la versión proporcionada y sale. |

La referencia pública enumera las opciones para usuarios; los anfitriones de escritorio gestionan su propia coordinación privada de inicio.

### Entorno adicional de despliegue {#deployment-environment}

| Variable | Valor predeterminado y ámbito |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`; repositorio consultado para ofertas de versiones. |
| `CODENOMAD_REMOTE_CONTROL_API` | Sin definir: API alojada de OpenTunnel. Establece un origen API para un despliegue de relé autoalojado. |
| `NODE_EXTRA_CA_CERTS` | Archivo CA adicional opcional de Node; se pasa con el entorno de inicio permitido al iniciar un daemon OpenCode ausente. No cambia un daemon ya en ejecución. |

Las credenciales de uso específicas de proveedores se cubren en [Proveedores](providers.md). La selección del perfil de datos de escritorio se cubre en [Escritorio](desktop.md); no la controla el canal de versiones.

## Configuración y propiedad del almacenamiento {#storage}

Las rutas predeterminadas siguientes usan el directorio personal del usuario del backend. Un directorio `--config` explícito cambia la base de configuración; un nombre de archivo YAML selecciona ese archivo con estado/almacenamiento hermanos. Usa una identidad de configuración deliberada para un despliegue y protege todo el directorio con permisos del sistema operativo.

| Propietario/datos | Ubicación predeterminada o regla |
| --- | --- |
| Preferencias estables de CodeNomad | `~/.config/codenomad/config.yaml` |
| Estado mutable de CodeNomad | `~/.config/codenomad/state.yaml` |
| Metadatos de instancias de CodeNomad | `~/.config/codenomad/instances/` |
| Hash de contraseña | `auth.json` junto a la configuración YAML activa; gestionado por la aplicación. |
| Certificados TLS generados y claves privadas | `tls/` bajo la base de configuración. |
| Ruta de Control remoto, elección de activación y hashes de dispositivos | `remote-control-devices.json` bajo la base de configuración. |
| Registro y carpetas de espacios de trabajo temporales | `temporary-workspaces.json` y `temporary-workspaces/` bajo esa base. |
| Extensiones de panel instaladas y comprobantes de permisos | `panel-extensions/` y `permission-receipts/` bajo esa base. |
| Caché de interfaz descargada | `~/.config/codenomad/ui/`; el resolvedor de interfaz de la CLI usa esta caché del directorio personal incluso con un `--config` personalizado. |
| Conversaciones OpenCode, mensajes, registro de servicio y conexiones de proveedores | Almacenamiento global propio de OpenCode en el equipo de ejecución, no el directorio de instancias de CodeNomad. |
| Estado de restauración de escritorio | Por defecto `~/.codenomad/client-state/v2/`; consulta [Escritorio](desktop.md) para el ámbito de perfil/ventana. |

CodeNomad se conecta al daemon compartido existente o lo inicia si falta. El entorno de inicio solo afecta a un daemon recién iniciado. Por separado, el entorno completo de sesión configurado se aplica antes de cada mensaje, comando personalizado o solicitud shell de sesión, no al simplemente ver o editar preferencias. Consulta [configuración de OpenCode](opencode.md).

## Eventos y reconexiones {#events}

El backend consume un flujo compartido de eventos nativos de OpenCode y multiplexa eventos del espacio de trabajo y de CodeNomad a clientes de navegador mediante Server-Sent Events. La entrega es en vivo y volátil: **no hay reproducción garantizada de eventos**.

Tras reconectar, la interfaz vuelve a obtener el estado autoritativo de sesiones y solicitudes pendientes; las invalidaciones de archivos/configuración también provocan lecturas nuevas. Reconectar no autoriza a repetir un envío, eliminación, respuesta u otra modificación cuya respuesta se perdió. Comprueba primero el estado resultante. Las solicitudes pendientes conocidas y los borradores se conservan cuando la recuperación es incompleta; consulta [Permisos](permissions.md) y [Solución de problemas](troubleshooting.md).

## Paquetes preliminares y mantenimiento {#maintenance}

Para probar explícitamente el paquete CLI preliminar:

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

Usa una configuración deliberadamente separada si necesitas ajustes aislados de CodeNomad; seleccionar un paquete no aísla el almacenamiento compartido de OpenCode. **Configuración → Info → Actualizaciones → Canal de actualizaciones** controla las versiones ofrecidas, no la identidad de datos del backend ni el paquete instalado.

`codenomad --upgrade` actualiza el paquete CLI estable global usando el gestor npm/pnpm/bun detectado (npm si no se detecta ninguno). No reinicia un servidor en ejecución ni actualiza OpenCode. Para una instalación local al proyecto o preliminar, actualiza explícitamente ese paquete npm exacto. Reinicia deliberadamente tu proceso gestionado de CodeNomad después de actualizar; comprueba de nuevo sus direcciones indicadas.

Consulta [Actualizaciones](updates.md) para mantenimiento de escritorio, [Soporte](support.md) para comandos de compilación desde el código fuente y [Proveedores](providers.md) para el uso de planes de proveedores.
