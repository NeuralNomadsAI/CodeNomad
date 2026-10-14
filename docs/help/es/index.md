# Ayuda de CodeNomad

Usa esta guía para trabajar en el espacio de trabajo actual de CodeNomad, en escritorio o navegador, con tu servicio OpenCode. Se centra en los controles de CodeNomad, los límites de ejecución y la recuperación, no en tutoriales de configuración de OpenCode ni en un archivo de versiones.

## Lee esto primero {#read-this-first}

CodeNomad conecta tu espacio de trabajo a un servicio compartido de OpenCode en segundo plano. Las sesiones y los mensajes pertenecen a OpenCode; las pestañas, los borradores del editor de mensajes y la disposición pertenecen al cliente CodeNomad. Cerrar una pestaña no detiene un espacio de trabajo, y cerrar CodeNomad no detiene OpenCode.

1. Comprueba los [requisitos del equipo anfitrión](install.md#requirements) y la [configuración de OpenCode](opencode.md).
2. [Abre un proyecto](projects.md) y elige los controles Agente, Modelo y Razonamiento de la conversación.
3. Comprueba el ámbito afectado antes de cambiar credenciales, reiniciar un servicio o eliminar el historial. Otros clientes pueden usar el mismo servicio nativo.

El sitio público de ayuda funciona sin CodeNomad, sin su backend y sin iniciar sesión. **Ayuda → Ayuda de CodeNomad** en escritorio y **Abrir ayuda** en la paleta de comandos lo abren por separado en el idioma actual de la interfaz. Los cambios de idioma no traducen las conversaciones almacenadas.

**Configuración** abre la ventana nativa de **Preferencias** en un cliente de escritorio local; los clientes de navegador y remotos usan la configuración integrada. Las rutas como **Configuración → Proveedores** identifican la misma sección de configuración en ambas superficies.

Para un espacio de trabajo de navegador independiente en un equipo preparado, la [guía del servidor](server.md) explica este inicio y sus requisitos de autenticación/TLS:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

## Elige tu cliente {#choose-your-client}

| Función | Escritorio local | Navegador directo o ventana de servidor remoto | Dispositivo emparejado con Control remoto |
| --- | --- | --- | --- |
| Proyectos, conversaciones, archivos e historial | Carpetas del backend y sesiones nativas | Carpetas y sesiones del servidor conectado | Superficies autorizadas del espacio de trabajo anfitrión |
| Preferencias nativas y ventanas de escritorio | Disponibles | La configuración del navegador/remota permanece en el cliente | Los controles exclusivos del escritorio anfitrión no están disponibles |
| Vista previa de navegador de la sesión | Nativa en Electron y Tauri para Windows; iframe en otras plataformas Tauri | Iframe donde esté disponible | Los endpoints de vista previa exclusivos del anfitrión no están disponibles |
| Automatización nativa de escritorio/navegador | Ventanas/vistas previas locales propias | No sustituye la automatización nativa de escritorio | Los endpoints de automatización exclusivos del anfitrión no están disponibles |
| Autenticación | Inicialización local o sesión con contraseña | Sesión con contraseña del servidor | Credencial del dispositivo emparejado |
| Instalación como PWA | Usa la aplicación nativa o un navegador | Depende del navegador; requiere un contexto seguro | Depende del navegador; sigue siendo necesario emparejarse |

Para conocer los límites exactos, consulta [vistas previas de navegador y SideCars](browser-sidecars.md), [Control remoto](remote-control.md) y [móvil/PWA](mobile.md). Una ventana remota no convierte el sistema de archivos de tu dispositivo en el espacio de trabajo del servidor.

## Comprende quién conserva cada estado {#state-and-scope}

| Término | Significado en CodeNomad |
| --- | --- |
| Pestaña de proyecto / espacio de trabajo / instancia | Una conexión de CodeNomad a una carpeta abierta explícitamente; varias pestañas pueden usar el servicio compartido. |
| Conversación / sesión | Historial y ejecución nativos de OpenCode asociados a su directorio. |
| Familia | Una conversación y sus subsesiones recursivas; relevante para movimientos, actividad, Yolo y controles de Misiones. |
| Worktree | Una copia de trabajo propia del repositorio seleccionada para explorar o ubicar sesiones. Explorarla no mueve una conversación. |
| Location | Contexto de ejecución nativo de OpenCode con ámbito de directorio; **Detener espacio de trabajo** libera explícitamente sus recursos, no el daemon compartido. |
| Backend de CodeNomad | El servidor que proporciona el espacio de trabajo, Git, la autenticación y la conectividad de los clientes. Su cuenta y su entorno determinan el acceso del backend al sistema de archivos. |
| Configuración | Ajustes de CodeNomad en el directorio de configuración del servidor; los ajustes Global/Proyecto de OpenCode tienen su propio ámbito nativo. |
| Ventana | Sus propias pestañas, navegación, borradores y vista restaurada. El historial nativo se comparte, no se copia para cada ventana. |
| Perfil de datos de escritorio | Selección explícita de almacenamiento nativo/del cliente; no aísla automáticamente las sesiones de OpenCode ni toda la configuración compartida. |

La raíz del espacio de trabajo limita qué carpetas abre CodeNomad; no es un entorno aislado para el agente. Revisa la [seguridad](security.md) antes de exponer un equipo o permitir acceso amplio a las herramientas.

## Explora por tarea {#explore-by-task}

| Tarea | Guía |
| --- | --- |
| Instalar o servir el espacio de trabajo | [Instalación](install.md), [Referencia del servidor](server.md), [Red y TLS](remote-access.md) |
| Trabajar con varias copias de trabajo y conversaciones | [Proyectos](projects.md), [Conversaciones](conversations.md), [Archivos](files.md) |
| Buscar en el historial o limpiarlo de forma segura | [Historial](history.md) |
| Responder preguntas y permisos nativos | [Permisos](permissions.md) |
| Coordinar trabajo acotado o diario | [Misiones](missions.md) |
| Configurar la ejecución y las integraciones | [OpenCode](opencode.md), [Proveedores](providers.md), [Integraciones](integrations.md) |
| Conectar otro dispositivo | [Control remoto](remote-control.md), [Seguridad](security.md), [Móvil](mobile.md) |
| Adaptar el espacio de trabajo | [Configuración](settings.md), [Atajos](shortcuts.md), [Voz](voice.md), [Extensiones](extensions.md) |
| Gestionar la aplicación nativa | [Escritorio](desktop.md), [Vistas previas de navegador y SideCars](browser-sidecars.md), [Actualizaciones](updates.md) |
| Diagnosticar o contribuir | [Solución de problemas](troubleshooting.md), [Soporte y compilaciones desde el código fuente](support.md) |

## Supervisa el trabajo sin modificarlo {#monitor-work}

El panel Estado muestra el uso del proveedor de la sesión activa y los Shells nativos en segundo plano. El estado de las conversaciones y la actividad de sus descendientes identifican sesiones que están trabajando, compactándose o esperando entrada. Supervisar un Shell en segundo plano es distinto de enviar una solicitud Shell desde el editor de mensajes o usar un SideCar de terminal alojado por separado.

1. Abre **Estado → Shells en segundo plano** para la Location de la conversación seleccionada (o el espacio de trabajo abierto si no hay una conversación seleccionada).
2. Inspecciona el comando, el shell, el directorio, el estado, el PID y el código de salida cuando se proporcionen; elige **Ver salida** para consultar la salida nativa disponible.
3. Para eliminar uno, usa **Detener y eliminar** mientras esté en ejecución, o **Eliminar** después de terminar, y confirma el objetivo.

Eliminar un Shell en ejecución detiene ese proceso; cerrar su ventana de salida no lo detiene. Actualizar/reconectar lee el estado nativo actual en lugar de reconstruir los eventos de salida perdidos.

Las instantáneas de visualización se actualizan tras cambios nativos, al reconectar y cuando una vista visible las necesita. No son registros con reproducción garantizada. Si un resultado es incierto, actualiza el estado autoritativo antes de reintentar una modificación; no vuelvas a enviarla solo porque se haya perdido una notificación o un evento.
