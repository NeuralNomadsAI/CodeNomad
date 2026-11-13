# Vistas previas de navegador y SideCars

## Abrir el navegador de una sesión {#session-browser}

1. En la barra de herramientas de una conversación, elige **Abrir vista previa web**.
2. Introduce una **URL de vista previa** `http://` o `https://` sin credenciales y elige **Abrir vista previa**. Usa la barra de herramientas para navegar, actualizar e ir Atrás/Adelante.
3. Usa el botón de cierre de la vista previa para volver al chat. Ábrela de nuevo en esa conversación para continuar.

Los service workers permanecen desactivados en las vistas previas remotas.

Pulsar un enlace `localhost` o `127.0.0.1` en una conversación lo abre en la vista previa web de esa sesión, en cualquier cliente donde las vistas previas estén disponibles. A través de Remote Control cuando el host mantiene las vistas previas web desactivadas, o en un cliente donde las vistas previas no están disponibles de otro modo, esos enlaces conservan su comportamiento normal del navegador. Ctrl+clic (⌘-clic en macOS) o clic central abre el enlace en tu navegador en su lugar. Dentro del marco de vista previa aislado (sandbox), donde no hay almacenamiento real disponible, la página recibe un `localStorage`, `sessionStorage` y `document.cookie` en memoria para la carga actual de la página; un host de vista previa por token abierto por sí mismo conserva su almacenamiento real.

Cada vista previa pertenece a su carpeta de proyecto y sesión. Cambiar de conversación, proyecto, Info o chat oculta un navegador invitado nativo abierto explícitamente sin descartar su documento/historial activo. Los navegadores invitados ocultos no son objetivos de automatización. Cerrar el proyecto/ventana o reiniciar el renderer termina el documento activo.

El historial guardado solo se restaura cuando vuelves a abrir explícitamente el navegador de esa sesión, no al iniciar/seleccionar una sesión. Guarda URL y un cursor, no formularios sin enviar, DOM, cuerpos POST ni memoria JavaScript. El historial se limita a 32 URL por sesión y a un presupuesto compartido de disposición; pueden recortarse las entradas antiguas. Restaurar una URL puede realizar una carga nueva de página; no es una repetición de transacciones.

Las pestañas de proyectos remotos cargan las vistas previas mediante el servidor CodeNomad del proyecto. La barra de direcciones y el historial guardado muestran la URL de la aplicación. Cerrar la vista previa o la pestaña, desconectar/eliminar el servidor o salir termina la página activa y sus conexiones; al reabrirla se carga la dirección guardada con su historial. Las credenciales del servidor permanecen en el backend; las cookies de aplicación transmitidas se filtran. Mantén las direcciones internas de carga dentro de CodeNomad.

Las vistas previas remotas nativas desactivan menús contextuales, arrastre de enlaces, impresión, ventanas emergentes, descargas, diálogos de página y solicitudes de permisos para mantener privadas las direcciones internas. Guarda el trabajo de la página antes de cerrarla.

## Inicios de sesión compartidos y límites de automatización {#signins-automation}

Las vistas previas nativas comparten cookies, inicios de sesión y almacenamiento de sitios entre proyectos/sesiones dentro del mismo motor de escritorio y ámbito de perfil/configuración, separados del renderer de confianza de CodeNomad. Cerrar sesión en un sitio desde una vista previa afecta a las demás que usen ese almacén. Documentos, formularios, almacenamiento de sesión, historiales de navegación y vínculos de automatización siguen perteneciendo a cada sesión. Las vistas previas iframe no son un perfil completo compartido de navegador nativo.

| Cliente | Implementación de vista previa | Automatización de navegador del agente | Plantillas móviles |
| --- | --- | --- | --- |
| Electron en plataformas de escritorio compatibles | Navegador invitado Chromium nativo; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para Windows | Ventana hija nativa WebView2; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para macOS (14+) | Ventana hija nativa WKWebView; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Identidad móvil WebKit y viewport CSS; límites nativos de entrada |
| Tauri para Linux | Ventana hija nativa WebKitGTK; ventanas OAuth, descargas y diálogos | Compatible para la vista previa visible de la sesión propia | Identidad móvil WebKit y viewport CSS; límites nativos de densidad/entrada |
| Navegador normal/vista remota | Alternativa iframe | Sin objetivo local de vista previa nativa | Solo dimensiones |

En todos los hosts de escritorio nativos, la herramienta `codenomad.browser` vinculada a la sesión abre, navega y captura la vista previa, y ejecuta clic, escritura, selección, hover, arrastre, desplazamiento, teclas y espera de texto. La ejecución comprueba el backend propietario, capacidades nativas, sesión y objetivo visible. Los objetivos ocultos, sustituidos o navegados se rechazan; las acciones nunca se repiten automáticamente. El contenido sigue sin ser fiable. Si el sitio bloquea iframe, usa un navegador externo.

Las vistas previas nativas se abren manualmente o mediante el agente, conservan inicios de sesión entre reinicios y usan el historial nativo Atrás/Adelante. Menús y diálogos locales ocultan la vista. Los comentarios sobre elementos no están disponibles en modo nativo. WebKit captura shadow roots cerrados creados por script; los declarativos cerrados permanecen opacos. En macOS, el primer hover puede omitir pointerenter y ⌘A selecciona de forma nativa sin keydown A. En GTK se lee el portapapeles mediante Ctrl+V explícito; escritura y copiar/pegar nativos funcionan.

Las ventanas emergentes nativas comparten las sesiones de la vista previa, conservan `opener`/`postMessage` y se cierran con su página de origen. Las direcciones introducidas/restauradas permiten HTTP(S) sin credenciales; los sitios también pueden abrir documentos vacíos y blob del mismo origen. Se bloquean los esquemas de archivos y de la aplicación. Las descargas usan nombres saneados y únicos en Descargas, sin sobrescribir ni abrir archivos automáticamente. Se deniegan cámara, micrófono, ubicación y notificaciones; los permisos clasificados requieren consentimiento y las solicitudes desconocidas muestran un error. Tauri y Electron admiten `alert`/`confirm`/`prompt`; el diálogo prompt de Electron cubre las páginas principales de la vista previa, las ventanas emergentes y los submarcos. Los selectores de dispositivos y pantallas permiten desplazarse por las entradas disponibles. Otras API dependen del motor y del hardware.

Los sitios pueden pedir confirmación al cerrar una ventana emergente nativa. En Linux, el consentimiento para bloquear el puntero aparece en la parte superior de su ventana. Las versiones de WebKitGTK afectadas por [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), incluida 2.52.6, requieren el selector de archivos de la página para subir archivos, ya que el acceso a archivos arrastrados está bloqueado por seguridad. Guarde el trabajo de la página antes de cerrar o recargar la ventana de CodeNomad que la contiene.

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

En Electron y Tauri para Windows, las plantillas móviles establecen identidad Android/Chromium, orientación, entrada táctil y DPR 2.75 solo en el navegador invitado propio. Volver a adaptable/escritorio/tableta borra esos valores y recarga. Tauri para macOS/Linux aplica una identidad móvil WebKit genérica en HTTP y JavaScript y ajusta el viewport CSS con independencia del zoom/DPI de la aplicación; cambiar o restablecer plantillas recarga. macOS usa DPR nativo 2,75 cuando está disponible; la densidad GTK sigue el zoom de ajuste y el monitor. Pantalla, plataforma, medios de puntero/hover y máximo de contactos conservan valores nativos de escritorio. Los clics móviles GTK generan eventos táctiles nativos y de compatibilidad de ratón; macOS conserva el ratón. La alternativa iframe solo redimensiona. Los perfiles son referencias de disposición; teclados de teléfono, barras del sistema y ajustes de texto móvil quedan fuera de su alcance. Guarda el trabajo de la página antes de cambiar plantillas porque la recarga puede descartar estado sin enviar.

## Registrar un SideCar {#register-sidecar}

1. Inicia la herramienta web por separado en el equipo del backend de CodeNomad, escuchando en `127.0.0.1:<port>`.
2. Abre **Configuración → SideCars**. Introduce **Nombre** y **Puerto**; comprueba la **Ruta base** derivada (`/sidecars/<id>`).
3. Establece **Protocolo** para que coincida con el servicio de destino y elige **Modo de prefijo**.
4. Elige **Añadir SideCar** y después **Abrir SideCar** desde la página de inicio para abrir su pestaña.

| Opción | Efecto exacto |
| --- | --- |
| HTTPS (predeterminado del formulario) | CodeNomad conecta al destino como `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad conecta al destino como `http://127.0.0.1:<port>`. Esto no cambia el ajuste TLS de la conexión pública de CodeNomad. |
| Quitar prefijo (predeterminado) | `/sidecars/<id>/path` se reenvía al destino como `/path`. |
| Conservar prefijo | `/sidecars/<id>/path` se reenvía al destino sin cambios. Configura la ruta base del servicio para que coincida. |

El registro es configuración del servidor, compartida por sus clientes; no instala ni inicia el servicio. El puerto está en el equipo del backend, no en el portátil o teléfono desde el que miras. **En ejecución** indica accesibilidad, no que la aplicación/autenticación de la herramienta funcione correctamente. Eliminar el registro no detiene el proceso iniciado por separado. Cerrar su pestaña tampoco lo detiene.

Si no es accesible, comprueba el proceso y el puerto en el backend. Si carga el HTML pero fallan los recursos/WebSockets, comprueba la ruta base y el modo de prefijo de la herramienta. Recrea un registro incorrecto con los ajustes previstos; no expongas públicamente el destino solo para eludir un error de proxy. Las aplicaciones SideCar pueden exponer una terminal o archivos con la autoridad de la cuenta del servidor; confía en sus usuarios y configuración.

Un SideCar es una extensión de confianza de CodeNomad, no una vista previa aislada: su página se ejecuta con el propio origen de CodeNomad, por lo que sus scripts pueden usar CodeNomad con tu acceso de sesión iniciada. Registra solo servicios cuyo código sea de tu confianza. CodeNomad no reenvía al servicio sus propias cookies de inicio de sesión, mientras que las cookies propias del servicio se conservan.

El contenido de SideCar (`/sidecars/`) y sus WebSockets requieren una conexión loopback en el anfitrión. El registro mediante `/api/sidecars` está disponible para dispositivos emparejados y clientes directos de LAN autenticados. El contenido de las vistas previas activas (`/previews/`) está disponible mediante acceso directo por LAN con un token de capacidad válido; las vistas previas web de [Control remoto](remote-control.md#remote-surface) siguen disponibles con su token de capacidad mientras estén activadas. Consulta [Actualizar](remote-access.md#upgrading) para los requisitos del acceso directo.

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
