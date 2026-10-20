# Vistas previas de navegador y SideCars

## Abrir el navegador de una sesión {#session-browser}

1. En la barra de herramientas de una conversación, abre su vista previa web/de navegador.
2. Introduce una URL `http://` o `https://` sin credenciales. Usa la barra de herramientas para navegar, actualizar e ir Atrás/Adelante.
3. Usa el botón de cierre de la vista previa para volver al chat. Ábrela de nuevo en esa conversación para continuar.

Cada vista previa pertenece a su carpeta de proyecto y sesión. Cambiar de conversación, proyecto, Info o chat oculta un navegador invitado nativo abierto explícitamente sin descartar su documento/historial activo. Los navegadores invitados ocultos no son objetivos de automatización. Cerrar el proyecto/ventana o reiniciar el renderer termina el documento activo.

El historial guardado solo se restaura cuando vuelves a abrir explícitamente el navegador de esa sesión, no al iniciar/seleccionar una sesión. Guarda URL y un cursor, no formularios sin enviar, DOM, cuerpos POST ni memoria JavaScript. El historial se limita a 32 URL por sesión y a un presupuesto compartido de disposición; pueden recortarse las entradas antiguas. Restaurar una URL puede realizar una carga nueva de página; no es una repetición de transacciones.

## Inicios de sesión compartidos y límites de automatización {#signins-automation}

Las vistas previas nativas comparten cookies, inicios de sesión y almacenamiento de sitios entre proyectos/sesiones dentro del mismo motor de escritorio y ámbito de perfil/configuración, separados del renderer de confianza de CodeNomad. Cerrar sesión en un sitio desde una vista previa afecta a las demás que usen ese almacén. Documentos, formularios, almacenamiento de sesión, historiales de navegación y vínculos de automatización siguen perteneciendo a cada sesión. Las vistas previas iframe no son un perfil completo compartido de navegador nativo.

| Cliente | Implementación de vista previa | Automatización de navegador del agente | Plantillas móviles |
| --- | --- | --- | --- |
| Electron en plataformas de escritorio compatibles | Navegador invitado Chromium nativo | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para Windows | Ventana hija nativa WebView2 | Compatible para la vista previa visible de la sesión propia | Emulación de identidad Android/Chromium, entrada táctil y densidad |
| Tauri para macOS/Linux | Iframe aislado | Sin automatización nativa de navegador | Solo dimensiones |
| Navegador normal/vista remota | Alternativa iframe | Sin objetivo local de vista previa nativa | Solo dimensiones |

No hay interruptor de modo desarrollador ni reinicio adicional de activación. La automatización nativa se prepara al iniciar el escritorio y usa la herramienta `codenomad.browser` vinculada a la sesión para abrir, navegar, obtener una instantánea, hacer clic, escribir y capturar pantalla. Que una herramienta esté disponible no autoriza todas las ventanas: la ejecución comprueba el backend propietario, las capacidades nativas, la sesión y el objetivo visible. El contenido de las páginas sigue sin ser fiable. Un iframe puede fallar porque el destino prohíbe incrustarlo; usa un navegador externo en lugar de debilitar sus protecciones.

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

Si no es accesible, comprueba el proceso y el puerto en el backend. Si carga el HTML pero fallan los recursos/WebSockets, comprueba la ruta base y el modo de prefijo de la herramienta. Recrea un registro incorrecto con los ajustes previstos; no expongas públicamente el destino solo para eludir un error de proxy. Las aplicaciones SideCar pueden exponer una terminal o archivos con la autoridad de la cuenta del servidor; confía en sus usuarios y configuración. Control remoto no expone el tráfico proxy de aplicaciones SideCar; usa la vía adecuada de acceso directo descrita en [Acceso remoto](remote-access.md) y [Control remoto](remote-control.md).

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
