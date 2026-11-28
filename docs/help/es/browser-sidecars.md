# Vistas previas de navegador y SideCars

Las vistas previas iframe y los SideCars rechazan conexiones a las direcciones y puertos de escucha del propio CodeNomad, incluidos los alias DNS. Use el puerto independiente del servidor de su aplicación.

## Abrir el navegador de una sesión {#session-browser}

1. En la barra de herramientas de una conversación, elige **Abrir vista previa web**.
2. Introduce una **URL de vista previa** `http://` o `https://` sin credenciales y elige **Abrir vista previa**. Usa la barra de herramientas para navegar, actualizar e ir Atrás/Adelante.
3. Usa el botón de cierre de la vista previa para volver al chat. Ábrela de nuevo en la misma pestaña y conversación para continuar.

Los service workers permanecen desactivados en las vistas previas remotas.

Pulsar un enlace `localhost` o `127.0.0.1` en una conversación lo abre en la vista previa web de esa sesión, en cualquier cliente donde las vistas previas estén disponibles. A través de Remote Control cuando el host mantiene las vistas previas web desactivadas, o en un cliente donde las vistas previas no están disponibles de otro modo, esos enlaces conservan su comportamiento normal del navegador. Ctrl+clic (⌘-clic en macOS) o clic central abre el enlace en tu navegador en su lugar.

La vista previa nativa conserva la página al volver al chat o al moverla dentro de la misma ventana.

Cada pestaña guarda su elección de chat/vista previa; la sesión guarda la URL, la plantilla de viewport y el historial compartidos. Las páginas guardadas se cargan solo al reabrir explícitamente el navegador de sesión. Se conservan URL y un cursor; formularios activos, DOM, cuerpos POST y memoria JavaScript terminan con el documento. El historial se limita a 32 URL por sesión y a un presupuesto compartido por ventana; las entradas antiguas pueden recortarse. Restaurar una URL puede cargar de nuevo la página.

Las vistas previas remotas usan el servidor del proyecto y muestran la URL de la aplicación. Cerrar la vista previa o su pestaña, desconectar el servidor o salir termina la página activa. Al reabrir se cargan la dirección y el historial, no los cambios sin guardar. Mantén privadas las direcciones internas.

Las vistas previas remotas nativas desactivan menús contextuales, exportación al portapapeles, arrastre de enlaces, impresión, ventanas emergentes, descargas, diálogos de página y solicitudes de permisos para mantener privadas las direcciones internas. Guarda el trabajo de la página antes de cerrarla.

Los controles aparecen cuando el anfitrión y el servidor del proyecto remoto confirman que las vistas previas están disponibles.

En Control remoto, **Vistas previas web** está activado por defecto en **Configuración → Acceso remoto → Control remoto** en el equipo anfitrión. Al desactivarlo se cierran las vistas previas y sus WebSockets; al recargar se oculta **Abrir vista previa web**. Cerrar sesión o revocar un dispositivo emparejado cierra sus vistas previas y sus WebSockets.

## Inicios de sesión compartidos y límites de automatización {#signins-automation}

En Electron y Tauri para Windows, el reinicio automatizado (`codenomad.act`, `restart`) vuelve a iniciar el perfil, la configuración y la compilación inspeccionados. Si se restaura la ventana original, la vuelve a inspeccionar; si no, informa de su ausencia sin inspeccionar otra ventana. Una inspección que se complete correctamente durante la reconexión tiene prioridad.

Si se cancela el reinicio, usa `codenomad.inspect` con `targets: true` para listar las ventanas abiertas y luego inspecciona la que quieras mediante su `target`.

Las vistas previas nativas comparten cookies, inicios de sesión y almacenamiento de sitios entre proyectos/sesiones dentro del mismo motor de escritorio y ámbito de perfil/configuración, separados del renderer de confianza de CodeNomad. Cerrar sesión en un sitio desde una vista previa afecta a las demás que usen ese almacén. Documentos, formularios, almacenamiento de sesión, historiales de navegación y vínculos de automatización pertenecen a cada sesión.

Cada sesión tiene una sola vista previa nativa. Si una pestaña duplicada muestra **Vista previa abierta en otra pestaña**, elige **Ir a la pestaña** para encontrarla o **Abrir aquí** para moverla dentro de la misma ventana. La pestaña anterior muestra entonces el mismo mensaje. Al cerrar la pestaña que contiene la vista previa, puedes abrirla en otra.

Mientras una ventana de escritorio muestra una conversación, sus agentes pueden controlar su vista previa con las herramientas de navegador de OpenCode (OpenCode 2.4 o posterior); se rechaza ejecutar scripts en la página y, en la app Tauri en macOS y Linux, no pueden retroceder, avanzar ni recargar. En Electron y en la app Tauri de Windows también pueden leer los mensajes de consola y las solicitudes de red de la vista previa; ven los encabezados y los cuerpos de texto de solicitudes y respuestas mientras la vista previa los conserve, salvo los valores de los encabezados de cookies y de autorización. El agente abre la vista previa en la pestaña que la contiene o, si aún no está abierta, en la última pestaña usada para esa sesión. Las acciones sobre la página se aplican a la vista previa nativa visible. Las páginas se cargan por la red de este equipo, como en la vista previa que ves, así que `localhost` es este equipo aunque OpenCode se ejecute en WSL.

El agente toma una instantánea antes de interactuar con la vista previa o capturarla. Si la vista previa cambia, el comando se detiene en lugar de usar otra.

| Cliente | Implementación de vista previa | Automatización de navegador del agente | Plantillas móviles |
| --- | --- | --- | --- |
| Electron en plataformas de escritorio compatibles | Navegador invitado Chromium nativo; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para Windows | Ventana hija nativa WebView2; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para macOS (14+) | Ventana hija nativa WKWebView; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Identidad móvil WebKit y viewport CSS; límites nativos de entrada |
| Tauri para Linux | Ventana hija nativa WebKitGTK; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Identidad móvil WebKit y viewport CSS; límites nativos de densidad/entrada |
| Navegador normal/vista remota | Alternativa iframe | Sin objetivo local de vista previa nativa | Solo dimensiones |

Los comentarios sobre elementos no están disponibles en modo nativo. En GTK se lee el portapapeles mediante Ctrl+V explícito; escritura y copiar/pegar nativos funcionan. Si el sitio bloquea iframe, usa un navegador externo.

Las ventanas emergentes nativas comparten las sesiones de la vista previa, conservan `opener`/`postMessage` y se cierran con su página de origen. Las direcciones introducidas/restauradas permiten HTTP(S) sin credenciales; los sitios también pueden abrir documentos vacíos y blob del mismo origen. Se bloquean los esquemas de archivos y de la aplicación. Las descargas usan nombres saneados y únicos en Descargas, sin sobrescribir ni abrir archivos automáticamente. Se deniegan cámara, micrófono, ubicación y notificaciones; los permisos clasificados requieren consentimiento y las solicitudes desconocidas muestran un error. Tauri y Electron admiten `alert`/`confirm`/`prompt`; el diálogo prompt de Electron cubre las páginas principales de la vista previa, las ventanas emergentes y los submarcos.

Los sitios pueden pedir confirmación al cerrar una ventana emergente nativa. Las versiones de WebKitGTK afectadas por [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), incluida 2.52.6, requieren el selector de archivos de la página para subir archivos, ya que el acceso a archivos arrastrados está bloqueado por seguridad. Guarde el trabajo de la página antes de cerrar o recargar la ventana de CodeNomad que la contiene.

En Tauri macOS/Linux, enfoque la vista previa para ampliarla con ⌘/Ctrl +, − o 0, o con el menú de zoom de la aplicación. Con el foco en otro lugar, estas acciones del menú amplían la aplicación.

## Elegir una de seis plantillas de área visible {#templates}

1. Abre el menú de área visible de la vista previa.
2. Selecciona una plantilla de las siguientes. Usa directamente las entradas vertical/horizontal; no hay un control de giro separado.
3. En Electron y Tauri para Windows, espera una recarga nativa al entrar/cambiar la emulación móvil o volver a una plantilla de solo dimensiones.

| Plantilla | Área visible CSS |
| --- | --- |
| Área visible adaptable | Espacio disponible de vista previa |
| Área visible de escritorio | 1440 × 900 |
| Área visible de tableta | 768 × 1024 |
| Tableta horizontal | 1024 × 768 |
| Área visible móvil | 390 × 844 |
| Móvil horizontal | 844 × 390 |

En Electron y Tauri para Windows, las plantillas móviles establecen identidad Android/Chromium, orientación, entrada táctil y DPR 2.75 solo en el navegador invitado propio. Volver a adaptable/escritorio/tableta borra esos valores y recarga. Tauri para macOS/Linux aplica una identidad móvil WebKit genérica en HTTP y JavaScript y ajusta el viewport CSS con independencia del zoom/DPI de la aplicación; cambiar o restablecer plantillas recarga. macOS usa DPR nativo 2,75 cuando está disponible; la densidad GTK sigue el zoom de ajuste y el monitor. La alternativa iframe solo redimensiona. Los perfiles son referencias de disposición; teclados de teléfono, barras del sistema y ajustes de texto móvil quedan fuera de su alcance. Guarda el trabajo de la página antes de cambiar plantillas porque la recarga puede descartar estado sin enviar.

## Registrar un SideCar {#register-sidecar}

1. Inicia la herramienta web por separado en el equipo del backend de CodeNomad, escuchando en `127.0.0.1:<port>`.
2. Abre **Configuración → SideCars**. Introduce **Nombre** y **Puerto**; comprueba la **Ruta base** derivada (`/sidecars/<id>`).
3. Establece **Protocolo** para que coincida con el servicio de destino y elige **Modo de prefijo**.
4. Elige **Añadir SideCar** y ábrelo desde **Explorar**. [pestañas de proyecto](projects.md#open-project).

Un SideCar en ejecución permanece en las pestañas recientes tras cerrar su pestaña.

| Opción | Efecto exacto |
| --- | --- |
| HTTPS (predeterminado del formulario) | CodeNomad conecta al destino como `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad conecta al destino como `http://127.0.0.1:<port>`. Esto no cambia el ajuste TLS de la conexión pública de CodeNomad. |
| Quitar prefijo (predeterminado) | `/sidecars/<id>/path` se reenvía al destino como `/path`. |
| Conservar prefijo | `/sidecars/<id>/path` se reenvía al destino sin cambios. Configura la ruta base del servicio para que coincida. |

El registro es configuración del servidor, compartida por sus clientes; no instala ni inicia el servicio. El puerto está en el equipo del backend, no en el portátil o teléfono desde el que miras. Eliminar el registro no detiene el proceso iniciado por separado. Cerrar su pestaña tampoco lo detiene.

Si no es accesible, comprueba el proceso y el puerto en el backend. Si carga el HTML pero fallan los recursos/WebSockets, comprueba la ruta base y el modo de prefijo de la herramienta. Recrea un registro incorrecto con los ajustes previstos; no expongas públicamente el destino solo para eludir un error de proxy. Las aplicaciones SideCar pueden exponer una terminal o archivos con la autoridad de la cuenta del servidor; confía en sus usuarios y configuración.

Un SideCar es una extensión de confianza de CodeNomad, no una vista previa aislada: su página se ejecuta con el propio origen de CodeNomad, por lo que sus scripts pueden usar CodeNomad con tu acceso de sesión iniciada. Registra solo servicios cuyo código sea de tu confianza. CodeNomad no reenvía al servicio sus propias cookies de inicio de sesión, mientras que las cookies propias del servicio se conservan.

El contenido de SideCar (`/sidecars/`) y sus WebSockets requieren una conexión loopback en el anfitrión. Para abrirlos también desde otros dispositivos, activa **Abrir SideCars por HTTPS** en **Configuración → SideCars** en el anfitrión: los navegadores con sesión iniciada a través de las direcciones HTTPS de este servidor o de un origen HTTPS de `CODENOMAD_ALLOWED_ORIGINS`, como un proxy inverso TLS, podrán abrir SideCars. HTTP sin cifrar, las direcciones `localhost` y Control remoto siguen reservados al anfitrión. El registro mediante `/api/sidecars` está disponible para dispositivos emparejados y clientes directos de LAN autenticados. El contenido de las vistas previas activas (`/previews/`) está disponible mediante acceso directo por LAN con un token de capacidad válido; las vistas previas web de [Control remoto](remote-control.md#remote-surface) siguen disponibles con su token de capacidad mientras estén activadas. Consulta [Orígenes permitidos](remote-access.md#upgrading) para los requisitos del acceso directo.

## Ejemplo de OpenVSCode Server {#openvscode}

1. En el equipo del backend, ejecuta Docker con el servicio limitado a loopback:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Registra **Nombre** `VSCode`, **Puerto** `8000`, **Protocolo** `HTTP`, **Modo de prefijo** **Conservar prefijo**.
3. Verifica que la ruta base mostrada sea `/sidecars/vscode` y abre el SideCar.

Este ejemplo de shell monta tu directorio personal en el contenedor; usa un montaje más limitado si el editor solo debe acceder a eso. El `--server-base-path` del servicio debe coincidir exactamente con el registro. Detén el contenedor por separado al terminar; eliminar el SideCar no lo elimina ni borra sus archivos.

## Ejemplo de terminal ttyd {#ttyd}

1. En el equipo del backend, inicia una terminal shell con escritura limitada a loopback:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Registra **Nombre** `Terminal`, **Puerto** `7681`, **Protocolo** `HTTP`, **Modo de prefijo** **Quitar prefijo**.
3. Abre el SideCar en su ruta base mostrada `/sidecars/terminal`.

La terminal se ejecuta con los privilegios de la cuenta que inició ttyd. Elige otro shell si `zsh` no está disponible. Usa el puerto real si cambiaste el predeterminado de ttyd y detenlo por separado al terminar. Autentica y protege el acceso a CodeNomad; una terminal con escritura no es un entorno aislado.
