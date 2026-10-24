# Vistas previas de navegador y SideCars

## Abrir el navegador de una sesión {#session-browser}

1. En la barra de herramientas de una conversación, elige **Abrir vista previa web**.
2. Introduce una **URL de vista previa** `http://` o `https://` sin credenciales y elige **Abrir vista previa**. Usa la barra de herramientas para navegar, actualizar e ir Atrás/Adelante.
3. Usa el botón de cierre de la vista previa para volver al chat. Ábrela de nuevo en esa conversación para continuar.

Pulsar un enlace `localhost` o `127.0.0.1` en una conversación lo abre automáticamente en la vista previa de esa sesión, en cualquier cliente: el servidor usa un proxy para las vistas previas de loopback, por lo que también funcionan desde un navegador normal en otra máquina. Las vistas previas de loopback con proxy siguen **Configuración → Vista previa**; el modo opaco predeterminado las aísla de CodeNomad. Los enlaces externos siguen abriéndose en una pestaña nueva del navegador.

Cada vista previa pertenece a su carpeta de proyecto y sesión. Cambiar de conversación, proyecto, Info o chat oculta un navegador invitado nativo abierto explícitamente sin descartar su documento/historial activo. Los navegadores invitados ocultos no son objetivos de automatización. Cerrar el proyecto/ventana o reiniciar el renderer termina el documento activo.

El historial guardado solo se restaura cuando vuelves a abrir explícitamente el navegador de esa sesión, no al iniciar/seleccionar una sesión. Guarda URL y un cursor, no formularios sin enviar, DOM, cuerpos POST ni memoria JavaScript. El historial se limita a 32 URL por sesión y a un presupuesto compartido de disposición; pueden recortarse las entradas antiguas. Restaurar una URL puede realizar una carga nueva de página; no es una repetición de transacciones.

## Orígenes y permisos de las vistas previas {#preview-origins}

Las vistas previas permanecen en la conversación; CodeNomad no abre una ventana de vista previa separada. **Configuración → Vista previa** establece una política para todo el servidor CodeNomad. Se aplica a las vistas previas de las vistas de navegador y remota. Tauri en macOS y Linux usa un iframe: conserva un origen aislado por token cuando la ventana local se sirve por loopback; de lo contrario, usa el origen de ruta seleccionado, y sigue estos interruptores. Las vistas web nativas de Electron y Tauri en Windows conservan su propio comportamiento de permisos, descargas y ventanas emergentes.

| Modo de origen | Efecto |
| --- | --- |
| Opaco (recomendado) | Ninguna vista previa comparte origen con CodeNomad ni con otra vista previa. El almacenamiento, las cookies, los service workers y las API del navegador ligadas al origen no están disponibles, así que algunas aplicaciones web pueden no funcionar. |
| Mismo origen que CodeNomad | Las vistas previas de loopback se ejecutan en el origen de CodeNomad; las externas siguen siendo opacas. |
| Origen de vista previa dedicado | Las vistas previas de loopback se ejecutan en el origen que configures; las externas siguen siendo opacas. |

**Mismo origen que CodeNomad significa confianza total.** El código de la vista previa puede leer y cambiar el almacenamiento, la transcripción y el DOM de CodeNomad, llamar a API de la aplicación con tu sesión y registrar service workers que persisten después de cerrar la vista previa. Úsalo solo en un servidor que controles y en el que confíes, nunca en un servidor compartido o remoto. CodeNomad pide confirmación antes de activarlo.

Para **Origen de vista previa dedicado**, usa un nombre de host distinto de todos los orígenes desde los que se sirve CodeNomad y enruta `/previews/*`, incluidas las actualizaciones WebSocket, al mismo servidor. Conserva la cabecera `Host`, las cabeceras de respuesta y la política de seguridad de contenido inyectada, y sirve el origen por TLS para las API de contexto seguro. CodeNomad no puede comprobar si el origen es accesible; una ruta rota hace fallar las vistas previas. Los Workers y service workers con rutas relativas a la raíz que evitan el espacio de nombres reescrito `/previews/<token>/...` no son compatibles con un origen dedicado. Un nombre de host distinto, no otro puerto, separa las cookies.

CodeNomad mantiene las cookies propias de un origen de vista previa dedicado separadas del origen de CodeNomad. Si el origen de vista previa es un subdominio hermano, sigue siendo del mismo sitio, por lo que el navegador envía la cookie de sesión `SameSite=Lax` de CodeNomad en las solicitudes a CodeNomad; CodeNomad rechaza las solicitudes a la API de la aplicación (`/api/`, `/workspaces/`, `/sidecars/`) que llevan ese origen en `Origin` o `Referer`. Usa un sitio diferente cuando se requiera un aislamiento estricto de cookies.

Los interruptores de **Sandbox** permiten formularios, diálogos modales, ventanas emergentes y descargas en las vistas previas iframe; los scripts siempre son necesarios. Los de **Funciones del navegador** solo permiten que una vista previa solicite cámara, micrófono, lectura/escritura del portapapeles, geolocalización o pantalla completa. El navegador seguirá pidiendo permiso, y la configuración del sitio en el navegador sigue siendo la autoridad final: un interruptor de CodeNomad no puede anular un bloqueo del navegador, y un permiso del navegador no puede restaurar una función desactivada. Las vistas web nativas de Electron y Tauri en Windows no siguen estos interruptores de iframe.

Cambiar el modo de origen, el origen dedicado, el sandbox o la política de funciones recarga una vista previa abierta, para que un documento más confiable no siga vivo tras una reducción de confianza.

## Inicios de sesión compartidos y límites de automatización {#signins-automation}

Las vistas previas nativas comparten cookies, inicios de sesión y almacenamiento de sitios entre proyectos/sesiones dentro del mismo motor de escritorio y ámbito de perfil/configuración, separados del renderer de confianza de CodeNomad. Cerrar sesión en un sitio desde una vista previa afecta a las demás que usen ese almacén. Documentos, formularios, almacenamiento de sesión, historiales de navegación y vínculos de automatización siguen perteneciendo a cada sesión. Las vistas previas iframe no son un perfil completo compartido de navegador nativo.

| Cliente | Implementación de vista previa | Automatización de navegador del agente | Plantillas móviles |
| --- | --- | --- | --- |
| Electron en plataformas de escritorio compatibles | Navegador invitado Chromium nativo | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para Windows | Ventana hija nativa WebView2 | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para macOS/Linux | Iframe aislado | Sin automatización nativa de navegador | Solo dimensiones |
| Navegador normal/vista remota | Alternativa iframe | Sin objetivo local de vista previa nativa | Solo dimensiones |

La automatización nativa se prepara al iniciar el escritorio y usa la herramienta `codenomad.browser` vinculada a la sesión para abrir, navegar, obtener una instantánea, capturar pantalla y realizar acciones en la página: hacer clic, escribir, seleccionar, pasar el cursor, arrastrar, desplazarse, pulsar teclas y esperar un texto. Que una herramienta esté disponible no autoriza todas las ventanas: la ejecución comprueba el backend propietario, las capacidades nativas, la sesión y el objetivo visible. Una acción cuya página se ocultó, se sustituyó o navegó mientras tanto se rechaza en lugar de enviarse a otra página, y una acción nunca se repite automáticamente. El contenido de las páginas sigue sin ser fiable. Un iframe puede fallar porque el destino prohíbe incrustarlo; usa un navegador externo en lugar de debilitar sus protecciones.

## Elegir una de seis plantillas de área visible {#templates}

1. Abre el menú de área visible de la vista previa.
2. Selecciona una plantilla de las siguientes. Usa directamente las entradas vertical/horizontal; no hay un control de giro separado.
3. Espera una recarga nativa al entrar/cambiar la emulación móvil o volver a una plantilla de solo dimensiones.

| Plantilla | Área visible CSS |
| --- | --- |
| Área visible adaptable | Espacio disponible de vista previa |
| Área visible de escritorio | 1440 × 900 |
| Área visible de tableta | 768 × 1024 |
| Tableta horizontal | 1024 × 768 |
| Área visible móvil | 390 × 844 |
| Móvil horizontal | 844 × 390 |

Las plantillas móviles nativas establecen identidad Android/Chromium, orientación, entrada táctil y DPR 2.75 solo en el navegador invitado propio. Volver a adaptable/escritorio/tableta borra esos valores y recarga. La alternativa iframe solo cambia el tamaño. Son referencias de disposición reproducibles, no emulación Safari/Firefox ni simulaciones de teclados de teléfono, barras del navegador/sistema o ajustes de texto del sistema móvil. Guarda el trabajo de la página antes de cambiar plantillas porque la recarga puede descartar estado sin enviar.

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

Un SideCar es una extensión de confianza de CodeNomad, no una vista previa aislada: su página se ejecuta con el propio origen de CodeNomad, por lo que sus scripts pueden usar CodeNomad con tu acceso de sesión iniciada. Registra solo servicios cuyo código sea de tu confianza. CodeNomad no reenvía al servicio sus propias cookies de inicio de sesión, mientras que las cookies propias del servicio se conservan. Control remoto no expone el tráfico proxy de aplicaciones SideCar; usa la vía adecuada de acceso directo descrita en [Acceso remoto](remote-access.md) y [Control remoto](remote-control.md).

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
